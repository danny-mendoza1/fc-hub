import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONTENT_SECURITY_POLICY, handle } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/auth.ts";
import { diskAssets } from "../src/static.ts";
import { ALICE, addMember, call, createEnv, upload } from "./helpers.ts";

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

  it("has no inline scripts or styles that the CSP would block", async () => {
    const env = envWithAssets();
    const html = await (await handle(new Request("https://hub.test/"), env)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "inline <script>");
    assert.doesNotMatch(html, /<style\b/, "inline <style>");
    assert.doesNotMatch(html, /\son\w+=/, "inline event handler");
    assert.doesNotMatch(html, /\sstyle=/, "inline style attribute");
  });
});
