import {
  type AuthedMember,
  authenticateMember,
  clearSessionCookie,
  createMember,
  isAdmin,
  memberForKey,
  publicMember,
  sessionCookie,
} from "./auth.ts";
import { validateUpload } from "./contract.ts";
import { MeteredDatabase, ReadOnlyViolation, readOnly } from "./db/guards.ts";
import type { SqlDatabase } from "./db/types.ts";
import { HttpError } from "./http-error.ts";
import { type Fetcher, fetchIcon, ICON_ID_PATTERN } from "./icons.ts";
import { ingestUpload } from "./ingest.ts";
import { alsoIn, itemsInCommon } from "./item-overlap-store.ts";
import { type Limits, resolveLimits } from "./limits.ts";
import { overview, ownerItems } from "./owners.ts";
import { MAX_QUERY_LENGTH, searchItems } from "./search.ts";
import { checkWriteBudget, recordWrites, setWriteBudgetOverride, usageReport } from "./usage.ts";
import { ID_PATTERN } from "./validation.ts";
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
  /** Site-wide limit overrides (see limits.ts ENV_NAMES), e.g. LIMIT_MEMBER_DAILY_WRITE_ROWS. */
  [limit: `LIMIT_${string}`]: string | number | undefined;
  /** "false" puts the site in read-only mode (all uploads refused). */
  WRITES_ENABLED?: string | boolean;
}

// --- routing ------------------------------------------------------------------------------
//
// Every route declares who may call it and whether it may write (ADR 0005), and the router
// enforces both: `writes: "none"` handlers get a database that throws on any write, `metered`
// handlers are checked against the daily write budget and charged for what they write. A route
// can't be added without choosing, and GET routes can only choose "none".

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** public: anyone · member: API key header only · memberOrCookie: key or browser session (reads) · admin: ADMIN_TOKEN */
type Access = "public" | "member" | "memberOrCookie" | "admin";

type Policy =
  | { access: Access; writes: "none" }
  /** Uploads: bearer key only (a cookie can't write), budget-checked and charged to the member. */
  | { access: "member"; writes: "metered" }
  /** Admin maintenance: unmetered, ADMIN_TOKEN only. */
  | { access: "admin"; writes: "admin" };

type PolicyFor<M extends Method> = M extends "GET" ? Extract<Policy, { writes: "none" }> : Policy;

export interface RouteContext {
  request: Request;
  /** Everything but the raw database, so a handler can't sidestep its policy. */
  env: Omit<AppEnv, "DB">;
  params: Record<string, string>;
  /** Read-only, metered or plain, as the route's policy says. */
  db: SqlDatabase;
  /** The caller, on member and memberOrCookie routes (see ContextFor); null elsewhere. */
  member: AuthedMember | null;
  limits: Limits;
  now: Date;
}

/** Routes that require a member always have one, so their handlers get it without a null check. */
type ContextFor<P extends Policy> = P["access"] extends "member" | "memberOrCookie"
  ? RouteContext & { member: AuthedMember }
  : RouteContext;

type Handler = (ctx: RouteContext) => Promise<Response>;

interface Route {
  method: Method;
  path: string;
  policy: Policy;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Every route and its policy, for tests that check the policies hold. */
export function routeTable(): readonly { method: Method; path: string; policy: Policy }[] {
  return routes.map(({ method, path, policy }) => ({ method, path, policy }));
}

function route<M extends Method, const P extends PolicyFor<M>>(
  method: M,
  path: string,
  policy: P,
  handler: (ctx: ContextFor<P>) => Promise<Response>,
): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:(\w+)/g, (_match, key: string) => {
        keys.push(key);
        return "([^/]+)";
      }) +
      "$",
  );
  // run() authenticates before calling the handler, which is what makes ContextFor's promise true.
  routes.push({ method, path, policy, pattern, keys, handler: handler as Handler });
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
      return await run(r, request, env, params);
    }
    if (pathMatched) return error(405, "method_not_allowed", "Method not allowed");

    // Everything outside the API is the static UI.
    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      return await env.ASSETS.fetch(request);
    }
    return error(404, "not_found", "Not found");
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.code, err.message, err.details, err.headers);
    // A read route tried to write: a bug, never something the caller did. Fail loudly in logs.
    if (err instanceof ReadOnlyViolation) console.error("Read-only violation", err);
    else console.error("Unhandled error", err);
    return error(500, "internal", "Internal server error");
  }
}

/** Applies the route's policy: authentication, then the database it's allowed to use. */
async function run(r: Route, request: Request, env: AppEnv, params: Record<string, string>): Promise<Response> {
  const { access, writes } = r.policy;
  const limits = resolveLimits(env);
  const now = new Date();

  let member: AuthedMember | null = null;
  if (access === "member" || access === "memberOrCookie") {
    member = await authenticateMember(env.DB, request, access === "memberOrCookie");
    if (!member) throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  } else if (access === "admin" && !(await isAdmin(request, env.ADMIN_TOKEN))) {
    throw new HttpError(401, "unauthorized", "Admin token required");
  }

  const { DB: _rawDb, ...envWithoutDb } = env;
  const ctx = { request, env: envWithoutDb, params, member, limits, now };
  if (writes === "none") return r.handler({ ...ctx, db: readOnly(env.DB) });
  if (writes === "admin") return r.handler({ ...ctx, db: env.DB });

  // writes === "metered" (always access: "member", so the caller is known): refuse once today's
  // budget is spent, then charge what this request wrote.
  if (!member) throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  const payer = member;
  const budget = await checkWriteBudget(env.DB, payer, limits, now);
  if (!budget.ok) {
    throw new HttpError(
      budget.reason === "disabled" ? 503 : 429,
      "write_budget",
      budget.message,
      { reason: budget.reason },
      {
        "retry-after": String(budget.retryAfterSeconds),
      },
    );
  }
  const metered = new MeteredDatabase(env.DB);
  try {
    return await r.handler({ ...ctx, db: metered });
  } finally {
    await recordWrites(env.DB, payer.id, metered.rowsWritten, now);
  }
}

// --- routes -------------------------------------------------------------------------------

route("GET", "/healthz", { access: "public", writes: "none" }, async () => json({ ok: true }));

/** Lets the plugin's "Test connection" button confirm its key works. */
route("GET", "/api/v1/me", { access: "memberOrCookie", writes: "none" }, async ({ db, member }) => {
  const characters = await db
    .prepare(
      `SELECT content_id AS contentId, name, home_world AS homeWorld, last_upload_at AS lastUploadAt
       FROM characters WHERE member_id = ? ORDER BY name`,
    )
    .bind(member.id)
    .all();
  return json({ member: publicMember(member), characters: characters.results });
});

route("POST", "/api/v1/snapshots", { access: "member", writes: "metered" }, async ({ request, db, member, limits, now }) => {
  const validation = validateUpload(await readJson(request, limits.maxBodyBytes), limits);
  if (!validation.ok) throw new HttpError(422, "invalid_upload", "Upload failed validation", validation.errors);
  return json(await ingestUpload(db, member, validation.value, limits, now));
});

route("GET", "/api/v1/search", { access: "memberOrCookie", writes: "none" }, async ({ request, db }) => {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) throw new HttpError(400, "query_too_long", `Search is limited to ${MAX_QUERY_LENGTH} characters`);
  return json(await searchItems(db, q));
});

route("GET", "/api/v1/overview", { access: "memberOrCookie", writes: "none" }, async ({ db }) => json({ characters: await overview(db) }));

/** The plugin's Wondrous Tails upload (one journal per member; bearer key only). */
route("POST", "/api/v1/wondrous-tails", { access: "member", writes: "metered" }, async ({ request, db, member, limits, now }) => {
  const validation = validateWondrousTails(await readJson(request, limits.maxBodyBytes));
  if (!validation.ok) throw new HttpError(422, "invalid_upload", "Upload failed validation", validation.errors);
  return json(await saveWondrousTails(db, member, validation.value, now));
});

/** Every member's journal with its status this week; "in common" is computed in the browser. */
route("GET", "/api/v1/wondrous-tails", { access: "memberOrCookie", writes: "none" }, async ({ db, now }) =>
  json(await listWondrousTails(db, now)),
);

/** One owner's items by section, for the "Who's uploaded" accordions (loaded on expand). */
route("GET", "/api/v1/owners/:ownerId/items", { access: "memberOrCookie", writes: "none" }, async ({ db, params }) => {
  const result = await ownerItems(db, ownerIdParam(params));
  if (!result) throw new HttpError(404, "not_found", "No such owner");
  return json(result);
});

/** Where else each of this owner's items is stored ("Also in" under the drill-down). */
route("GET", "/api/v1/owners/:ownerId/also-in", { access: "memberOrCookie", writes: "none" }, async ({ db, params }) =>
  json(await alsoIn(db, ownerIdParam(params))),
);

/** Items that two or more members (or the FC chest) store; the chosen party is applied in the browser. */
route("GET", "/api/v1/items/in-common", { access: "memberOrCookie", writes: "none" }, async ({ db }) => json(await itemsInCommon(db)));

/** Item icon by game icon id, proxied from XIVAPI (see icons.ts). Members only, so it isn't a public proxy. */
route("GET", "/api/v1/icons/:iconId", { access: "memberOrCookie", writes: "none" }, async ({ env, params }) => {
  const iconId = params.iconId ?? "";
  if (!ICON_ID_PATTERN.test(iconId)) throw new HttpError(400, "invalid_icon", "iconId must be a positive number");
  return fetchIcon(Number(iconId), env.FETCH ?? ((input, init) => fetch(input, init)));
});

/** Browser sign-in: trade the member's API key for an HttpOnly session cookie. Reads only. */
route("POST", "/api/v1/session", { access: "public", writes: "none" }, async ({ request, db }) => {
  assertSameOrigin(request);
  const body = (await readJson(request, 4096)) as { apiKey?: unknown };
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : null;
  const member = await memberForKey(db, apiKey);
  if (!member || !apiKey) throw new HttpError(401, "unauthorized", "That key isn't valid (or has been revoked).");
  const response = json({ member: publicMember(member) });
  response.headers.append("set-cookie", sessionCookie(apiKey));
  return response;
});

route("DELETE", "/api/v1/session", { access: "public", writes: "none" }, async ({ request }) => {
  assertSameOrigin(request);
  const response = new Response(null, { status: 204 });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
});

route("POST", "/api/v1/admin/members", { access: "admin", writes: "admin" }, async ({ request, db }) => {
  const body = (await readJson(request, 4096)) as { displayName?: unknown };
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > 64) {
    throw new HttpError(422, "invalid_member", "displayName must be 1-64 characters");
  }
  const { member, apiKey } = await createMember(db, displayName);
  // The key is only ever returned here; the server stores its hash.
  return json({ member, apiKey }, 201);
});

route("POST", "/api/v1/admin/members/:id/revoke", { access: "admin", writes: "admin" }, async ({ db, params, now }) => {
  const result = await db
    .prepare("UPDATE members SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(now.toISOString(), Number(params.id))
    .run();
  if (result.meta.changes === 0) throw new HttpError(404, "not_found", "No active member with that id");
  return json({ revoked: Number(params.id) });
});

/** Today's D1 rows written per member against the budgets, and the limits in force. */
route("GET", "/api/v1/admin/usage", { access: "admin", writes: "none" }, async ({ db, limits, now }) =>
  json(await usageReport(db, limits, now)),
);

/**
 * Raise or lower one member's daily write budget without a deploy:
 * `{"dailyWriteRows": 2000000, "until": "2026-11-23T00:00:00Z"}`; `until` omitted = until cleared;
 * `{"dailyWriteRows": null}` clears it.
 */
route("PUT", "/api/v1/admin/members/:id/write-budget", { access: "admin", writes: "admin" }, async ({ request, db, params }) => {
  const body = (await readJson(request, 4096)) as { dailyWriteRows?: unknown; until?: unknown };
  const rows = body?.dailyWriteRows;
  if (rows !== null && !(typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 0)) {
    throw new HttpError(422, "invalid_budget", "dailyWriteRows must be a whole number ≥ 0, or null to clear");
  }
  const until = body?.until ?? null;
  if (until !== null && (typeof until !== "string" || Number.isNaN(Date.parse(until)))) {
    throw new HttpError(422, "invalid_budget", "until must be an ISO timestamp, or omitted");
  }
  const untilIso = until === null ? null : new Date(Date.parse(until)).toISOString();
  if (!(await setWriteBudgetOverride(db, Number(params.id), rows, untilIso)))
    throw new HttpError(404, "not_found", "No member with that id");
  return json({ memberId: Number(params.id), dailyWriteRows: rows, until: rows === null ? null : untilIso });
});

// --- helpers ------------------------------------------------------------------------------

function ownerIdParam(params: Record<string, string>): string {
  const ownerId = params.ownerId ?? "";
  if (!ID_PATTERN.test(ownerId)) throw new HttpError(400, "invalid_owner", "ownerId must be a decimal id");
  return ownerId;
}

/** Rejects browser requests coming from another site (defence in depth on top of SameSite). */
function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "cross_origin", "Cross-origin request rejected");
  }
}

/** Reads a JSON body, transparently un-gzipping it, with a hard cap on decompressed size. */
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
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
    if (total > maxBytes) {
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

function error(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>): Response {
  const response = json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
  for (const [name, value] of Object.entries(headers ?? {})) response.headers.set(name, value);
  return response;
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
