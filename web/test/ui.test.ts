import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { CONTENT_SECURITY_POLICY, handle } from "../src/app.ts";
import { hashKey, MAX_SESSIONS_PER_MEMBER, SESSION_COOKIE } from "../src/auth.ts";
import { compressBody } from "../src/node-server.ts";
import { staticHeadersFile } from "../src/security-headers.ts";
import { diskAssets } from "../src/static.ts";
import { ADMIN_TOKEN, ALICE, addMember, call, createEnv, upload } from "./helpers.ts";

const DIST = join(import.meta.dirname, "..", "dist");
const BUILT = existsSync(join(DIST, "index.html"));
const needsBuild = BUILT ? {} : { skip: "run `npm run build` first (CI builds before testing)" };

function envWithAssets() {
  return { ...createEnv(), ASSETS: diskAssets(DIST) };
}

async function signIn(env: ReturnType<typeof envWithAssets>, apiKey: string): Promise<Response> {
  return handle(
    new Request("https://hub.test/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hub.test" },
      body: JSON.stringify({ apiKey }),
    }),
    env,
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
}

describe("browser sessions", () => {
  it("trades a valid key for a hardened HttpOnly cookie", async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    const res = await signIn(env, key);
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.startsWith(`${SESSION_COOKIE}=`));
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) {
      assert.ok(setCookie.includes(attribute), `missing ${attribute}`);
    }
    assert.equal((await res.json()).member.displayName, "Danny");
  });

  it("rejects bad keys without setting a cookie", async () => {
    const env = envWithAssets();
    const res = await signIn(env, "fch_nope");
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("rejects cross-origin sign-in attempts", async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    const res = await handle(
      new Request("https://hub.test/api/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ apiKey: key }),
      }),
      env,
    );
    assert.equal(res.status, 403);
  });

  it("lets the cookie read but never write", async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    const cookie = cookieFrom(await signIn(env, key));

    for (const path of ["/api/v1/me", "/api/v1/search?q=ore", "/api/v1/overview"]) {
      const res = await call(env, "GET", path, { headers: { cookie } });
      assert.equal(res.status, 200, path);
    }

    const write = await call(env, "POST", "/api/v1/snapshots", { headers: { cookie }, body: upload(ALICE, "Alice", []) });
    assert.equal(write.status, 401, "uploads must require the Authorization header");
  });

  it("signs out by expiring the cookie", async () => {
    const env = envWithAssets();
    const res = await handle(new Request("https://hub.test/api/v1/session", { method: "DELETE" }), env);
    assert.equal(res.status, 204);
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });
});

describe("session tokens", () => {
  const me = (env: ReturnType<typeof envWithAssets>, cookie: string) => call(env, "GET", "/api/v1/me", { headers: { cookie } });
  const sessionCount = (env: ReturnType<typeof envWithAssets>) =>
    (env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

  it("puts a random session token in the cookie, never the API key, and stores only its hash", async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    const cookie = cookieFrom(await signIn(env, key));
    const token = decodeURIComponent(cookie.split("=")[1]!);
    assert.match(token, /^fchs_[A-Za-z0-9_-]{43}$/);
    assert.ok(!cookie.includes(key));
    const stored = env.DB.raw.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.token_hash, await hashKey(token));
    assert.equal((await me(env, cookie)).status, 200);
  });

  it("no longer accepts a cookie that holds an API key (sessions from before tokens)", async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    assert.equal((await me(env, `${SESSION_COOKIE}=${key}`)).status, 401);
  });

  it("ends the session on the server when signing out", async () => {
    const env = envWithAssets();
    const cookie = cookieFrom(await signIn(env, await addMember(env, "Danny")));
    const out = await handle(new Request("https://hub.test/api/v1/session", { method: "DELETE", headers: { cookie } }), env);
    assert.equal(out.status, 204);
    assert.equal(sessionCount(env), 0);
    assert.equal((await me(env, cookie)).status, 401, "a kept cookie must not keep working");
  });

  it("signs every browser out when the key is rotated or revoked", async () => {
    const env = envWithAssets();
    const danny = await addMember(env, "Danny");
    const bob = await addMember(env, "Bob");
    const dannyCookie = cookieFrom(await signIn(env, danny));
    const bobCookie = cookieFrom(await signIn(env, bob));

    await call(env, "POST", "/api/v1/admin/members/1/rotate-key", { token: ADMIN_TOKEN });
    assert.equal((await me(env, dannyCookie)).status, 401);
    assert.equal((await me(env, bobCookie)).status, 200, "other members stay signed in");

    await call(env, "POST", "/api/v1/admin/members/2/revoke", { token: ADMIN_TOKEN });
    assert.equal((await me(env, bobCookie)).status, 401);
    assert.equal(sessionCount(env), 0);
  });

  it("expires sessions after their lifetime and clears expired ones on the next sign-in", async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    const cookie = cookieFrom(await signIn(env, key));
    env.DB.raw.prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await me(env, cookie)).status, 401);
    await signIn(env, key);
    assert.equal(sessionCount(env), 1, "the expired session was cleared");
  });

  it(`keeps at most ${MAX_SESSIONS_PER_MEMBER} sessions per member, ending the oldest`, async () => {
    const env = envWithAssets();
    const key = await addMember(env, "Danny");
    const first = cookieFrom(await signIn(env, key));
    // Make the first session clearly the oldest (later sign-ins can share a millisecond).
    env.DB.raw.prepare("UPDATE sessions SET created_at = ?").run("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_SESSIONS_PER_MEMBER; i++) await signIn(env, key);
    assert.equal(sessionCount(env), MAX_SESSIONS_PER_MEMBER);
    assert.equal((await me(env, first)).status, 401, "the oldest session was ended");
  });
});

describe("static UI (built client)", needsBuild, () => {
  it("serves the page with a strict CSP and revalidation", async () => {
    const env = envWithAssets();
    const res = await handle(new Request("https://hub.test/"), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=/);
    assert.match(await res.text(), /<div id="root"><\/div>/);
  });

  it("caches hashed bundles forever but never caches misses", async () => {
    const env = envWithAssets();
    const bundle = readdirSync(join(DIST, "assets")).find((f) => f.endsWith(".js"));
    assert.ok(bundle, "no JS bundle in dist/assets");
    const js = await handle(new Request(`https://hub.test/assets/${bundle}`), env);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const missing = await handle(new Request("https://hub.test/assets/nope.js"), env);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-cache");
  });

  it("keeps API responses uncacheable and API 404s as JSON", async () => {
    const env = envWithAssets();
    const res = await handle(new Request("https://hub.test/api/v1/nope"), env);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await res.json()).error.code, "not_found");
  });

  it("refuses path traversal out of the public folder", async () => {
    const env = envWithAssets();
    for (const path of ["/%2e%2e/wrangler.toml", "/..%2fwrangler.toml", "/%2e%2e%2fpackage.json"]) {
      const res = await handle(new Request(`https://hub.test${path}`), env);
      assert.equal(res.status, 404, path);
    }
  });

  it("ships _headers matching the app's headers, for files Cloudflare serves without the Worker", async () => {
    const file = readFileSync(join(DIST, "_headers"), "utf8");
    assert.equal(file, staticHeadersFile(), "rebuild: npm run build");
    assert.ok(file.includes(`content-security-policy: ${CONTENT_SECURITY_POLICY}`));
    // The Worker must still run for the API, or API responses would lose auth and no-store.
    const wrangler = readFileSync(join(import.meta.dirname, "..", "wrangler.toml"), "utf8");
    assert.match(wrangler, /^run_worker_first = \["\/api\/\*", "\/healthz"\]$/m);
    // Like Cloudflare's asset server, the Node server doesn't serve the config file.
    assert.equal((await handle(new Request("https://hub.test/_headers"), envWithAssets())).status, 404);
  });

  it("has no inline scripts or styles that the CSP would block", async () => {
    const env = envWithAssets();
    const html = await (await handle(new Request("https://hub.test/"), env)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "inline <script>");
    assert.doesNotMatch(html, /<style\b/, "inline <style>");
    assert.doesNotMatch(html, /\son\w+=/, "inline event handler");
    assert.doesNotMatch(html, /\sstyle=/, "inline style attribute");
  });
});

describe("Node server extras (self-hosting)", () => {
  it("compresses text bodies for the client's Accept-Encoding, and leaves the rest alone", async () => {
    const json = new TextEncoder().encode(JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ name: "Iron Ore", i })) }));
    const br = await compressBody(json, "application/json; charset=utf-8", "gzip, deflate, br");
    assert.equal(br?.encoding, "br");
    assert.deepEqual(new Uint8Array(brotliDecompressSync(br!.body)), json);
    const gz = await compressBody(json, "application/json", "gzip");
    assert.equal(gz?.encoding, "gzip");
    assert.deepEqual(new Uint8Array(gunzipSync(gz!.body)), json);
    assert.equal(await compressBody(json, "application/json", null), null, "client didn't ask");
    assert.equal(await compressBody(json, "image/png", "br"), null, "already compressed");
    assert.equal(await compressBody(new Uint8Array(10), "text/html", "br"), null, "too small to bother");
  });

  it("revalidates static files with an ETag", needsBuild, async () => {
    const env = envWithAssets();
    const first = await handle(new Request("https://hub.test/"), env);
    const etag = first.headers.get("etag");
    assert.ok(etag, "no ETag");
    const again = await handle(new Request("https://hub.test/", { headers: { "if-none-match": etag } }), env);
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    assert.equal((await handle(new Request("https://hub.test/", { headers: { "if-none-match": '"stale"' } }), env)).status, 200);
  });
});
