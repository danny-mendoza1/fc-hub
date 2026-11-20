import { authenticateMember, clearSessionCookie, createMember, isAdmin, type Member, memberForKey, sessionCookie } from "./auth.ts";
import { validateUpload } from "./contract.ts";
import type { SqlDatabase } from "./db/types.ts";
import { IngestError, ingestUpload } from "./ingest.ts";
import { type Fetcher, fetchIcon, ICON_ID_PATTERN } from "./icons.ts";
import { MAX_QUERY_LENGTH, overview, ownerItems, searchItems } from "./search.ts";
import { validateWondrousTails } from "./wondrous-tails.ts";
import { listWondrousTails, saveWondrousTails } from "./wondrous-tails-store.ts";

export interface AppEnv {
  DB: SqlDatabase;
  /** Secret used only to create/revoke member keys. Unset → admin endpoints disabled. */
  ADMIN_TOKEN?: string;
  /** Static UI files (web/public): the Workers assets binding, or a disk reader on Node. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Outbound fetch for item icons (tests inject a fake). Defaults to the global fetch. */
  FETCH?: Fetcher;
}

/** Decompressed upload size cap; a full snapshot is ~250 KB, so this is generous. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

type Handler = (request: Request, env: AppEnv, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    }) + "$",
  );
  routes.push({ method, pattern, keys, handler });
}

/** Web-standard entry point shared by the Cloudflare Worker and the Node server. */
export async function handle(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  return withSecurityHeaders(await dispatch(request, env, url), url);
}

async function dispatch(request: Request, env: AppEnv, url: URL): Promise<Response> {
  try {
    let pathMatched = false;
    for (const r of routes) {
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1] ?? "")]));
      return await r.handler(request, env, params);
    }
    if (pathMatched) return error(405, "method_not_allowed", "Method not allowed");

    // Everything outside the API is the static UI.
    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      return await env.ASSETS.fetch(request);
    }
    return error(404, "not_found", "Not found");
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.code, err.message, err.details);
    if (err instanceof IngestError) return error(err.status, "rejected", err.message);
    console.error("Unhandled error", err);
    return error(500, "internal", "Internal server error");
  }
}

// --- routes -------------------------------------------------------------------------------

route("GET", "/healthz", async () => json({ ok: true }));

/** Lets the plugin's "Test connection" button confirm its key works. */
route("GET", "/api/v1/me", async (request, env) => {
  const member = await requireMember(request, env, true);
  const characters = await env.DB.prepare(
    `SELECT content_id AS contentId, name, home_world AS homeWorld, last_upload_at AS lastUploadAt
     FROM characters WHERE member_id = ? ORDER BY name`,
  )
    .bind(member.id)
    .all();
  return json({ member, characters: characters.results });
});

route("POST", "/api/v1/snapshots", async (request, env) => {
  const member = await requireMember(request, env);
  const body = await readJson(request);
  const validation = validateUpload(body);
  if (!validation.ok) throw new HttpError(422, "invalid_upload", "Upload failed validation", validation.errors);
  const result = await ingestUpload(env.DB, member, validation.value);
  return json(result);
});

route("GET", "/api/v1/search", async (request, env) => {
  await requireMember(request, env, true);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) throw new HttpError(400, "query_too_long", `Search is limited to ${MAX_QUERY_LENGTH} characters`);
  return json(await searchItems(env.DB, q));
});

route("GET", "/api/v1/overview", async (request, env) => {
  await requireMember(request, env, true);
  return json({ characters: await overview(env.DB) });
});

/** The plugin's Wondrous Tails upload (one journal per member; bearer key only). */
route("POST", "/api/v1/wondrous-tails", async (request, env) => {
  const member = await requireMember(request, env);
  const validation = validateWondrousTails(await readJson(request));
  if (!validation.ok) throw new HttpError(422, "invalid_upload", "Upload failed validation", validation.errors);
  return json(await saveWondrousTails(env.DB, member, validation.value));
});

/** Every member's journal with its status this week; "in common" is computed in the browser. */
route("GET", "/api/v1/wondrous-tails", async (request, env) => {
  await requireMember(request, env, true);
  return json(await listWondrousTails(env.DB));
});

/** One owner's items by section, for the "Who's uploaded" accordions (loaded on expand). */
route("GET", "/api/v1/owners/:ownerId/items", async (request, env, params) => {
  await requireMember(request, env, true);
  const ownerId = params.ownerId ?? "";
  if (!/^[1-9][0-9]{0,19}$/.test(ownerId)) throw new HttpError(400, "invalid_owner", "ownerId must be a decimal id");
  const result = await ownerItems(env.DB, ownerId);
  if (!result) throw new HttpError(404, "not_found", "No such owner");
  return json(result);
});

/** Item icon by game icon id, proxied from XIVAPI (see icons.ts). Members only, so it isn't a public proxy. */
route("GET", "/api/v1/icons/:iconId", async (request, env, params) => {
  await requireMember(request, env, true);
  const iconId = params.iconId ?? "";
  if (!ICON_ID_PATTERN.test(iconId)) throw new HttpError(400, "invalid_icon", "iconId must be a positive number");
  return fetchIcon(Number(iconId), env.FETCH ?? ((input, init) => fetch(input, init)));
});

/** Browser sign-in: trade the member's API key for an HttpOnly session cookie. */
route("POST", "/api/v1/session", async (request, env) => {
  assertSameOrigin(request);
  const body = (await readJson(request)) as { apiKey?: unknown };
  const member = await memberForKey(env.DB, typeof body?.apiKey === "string" ? body.apiKey.trim() : null);
  if (!member) throw new HttpError(401, "unauthorized", "That key isn't valid (or has been revoked).");
  const response = json({ member });
  response.headers.append("set-cookie", sessionCookie((body.apiKey as string).trim()));
  return response;
});

route("DELETE", "/api/v1/session", async (request) => {
  assertSameOrigin(request);
  const response = new Response(null, { status: 204 });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
});

route("POST", "/api/v1/admin/members", async (request, env) => {
  await requireAdmin(request, env);
  const body = (await readJson(request)) as { displayName?: unknown };
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > 64) {
    throw new HttpError(422, "invalid_member", "displayName must be 1-64 characters");
  }
  const { member, apiKey } = await createMember(env.DB, displayName);
  // The key is only ever returned here; the server stores its hash.
  return json({ member, apiKey }, 201);
});

route("POST", "/api/v1/admin/members/:id/revoke", async (request, env, params) => {
  await requireAdmin(request, env);
  const result = await env.DB.prepare("UPDATE members SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), Number(params.id))
    .run();
  if (result.meta.changes === 0) throw new HttpError(404, "not_found", "No active member with that id");
  return json({ revoked: Number(params.id) });
});

// --- helpers ------------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function requireMember(request: Request, env: AppEnv, allowCookie = false): Promise<Member> {
  const member = await authenticateMember(env.DB, request, allowCookie);
  if (!member) throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  return member;
}

/** Rejects browser requests coming from another site (defence in depth on top of SameSite). */
function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "cross_origin", "Cross-origin request rejected");
  }
}

async function requireAdmin(request: Request, env: AppEnv): Promise<void> {
  if (!(await isAdmin(request, env.ADMIN_TOKEN))) throw new HttpError(401, "unauthorized", "Admin token required");
}

/** Reads a JSON body, transparently un-gzipping it, with a hard cap on decompressed size. */
async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new HttpError(400, "empty_body", "Request body is required");

  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "gzip" && encoding !== "identity") {
    throw new HttpError(415, "unsupported_encoding", "Only gzip-encoded bodies are supported");
  }
  const stream = encoding === "gzip" ? request.body.pipeThrough(new DecompressionStream("gzip")) : request.body;

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "Request body too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

/**
 * Strict CSP: only our own scripts/styles, no inline code, no framing, no third-party content.
 * Applied to every response (harmless on JSON) so the UI can't accidentally ship without it.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * API data is per-user and never cached. Vite's /assets/* files have content hashes in their
 * names, so they can be cached forever; everything else (index.html) is revalidated on each load
 * so a deploy shows up immediately.
 */
function cacheControl(pathname: string, status: number): string {
  // Icons never change for a given id; private because the route requires sign-in.
  if (pathname.startsWith("/api/v1/icons/") && status === 200) return "private, max-age=2592000, immutable";
  if (pathname.startsWith("/api/")) return "no-store";
  if (pathname.startsWith("/assets/") && status === 200) return "public, max-age=31536000, immutable";
  return "no-cache";
}

function withSecurityHeaders(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  headers.set("cache-control", cacheControl(url.pathname, response.status));
  if (url.protocol === "https:") headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
