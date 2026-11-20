import { authenticateMember, createMember, isAdmin, type Member } from "./auth.ts";
import { validateUpload } from "./contract.ts";
import type { SqlDatabase } from "./db/types.ts";
import { IngestError, ingestUpload } from "./ingest.ts";
import { MAX_QUERY_LENGTH, overview, searchItems } from "./search.ts";

export interface AppEnv {
  DB: SqlDatabase;
  /** Secret used only to create/revoke member keys. Unset → admin endpoints disabled. */
  ADMIN_TOKEN?: string;
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
  const { pathname } = new URL(request.url);
  try {
    let pathMatched = false;
    for (const r of routes) {
      const match = r.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1] ?? "")]));
      return withSecurityHeaders(await r.handler(request, env, params));
    }
    return withSecurityHeaders(pathMatched ? error(405, "method_not_allowed", "Method not allowed") : error(404, "not_found", "Not found"));
  } catch (err) {
    if (err instanceof HttpError) return withSecurityHeaders(error(err.status, err.code, err.message, err.details));
    if (err instanceof IngestError) return withSecurityHeaders(error(err.status, "rejected", err.message));
    console.error("Unhandled error", err);
    return withSecurityHeaders(error(500, "internal", "Internal server error"));
  }
}

// --- routes -------------------------------------------------------------------------------

route("GET", "/healthz", async () => json({ ok: true }));

/** Lets the plugin's "Test connection" button confirm its key works. */
route("GET", "/api/v1/me", async (request, env) => {
  const member = await requireMember(request, env);
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
  await requireMember(request, env);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) throw new HttpError(400, "query_too_long", `Search is limited to ${MAX_QUERY_LENGTH} characters`);
  return json(await searchItems(env.DB, q));
});

route("GET", "/api/v1/overview", async (request, env) => {
  await requireMember(request, env);
  return json({ characters: await overview(env.DB) });
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

async function requireMember(request: Request, env: AppEnv): Promise<Member> {
  const member = await authenticateMember(env.DB, request);
  if (!member) throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  return member;
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

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
