import type { SqlDatabase, SqlStatement } from "./db/types.ts";

/** Prefix makes keys recognisable (and greppable by secret scanners) if one ever leaks. */
const KEY_PREFIX = "fch_";
/** Browser session tokens look different from keys, so one can never be mistaken for the other. */
const SESSION_PREFIX = "fchs_";

export interface Member {
  id: number;
  displayName: string;
}

/**
 * What the server knows about the caller. Only `Member` (via `publicMember`) is ever sent to
 * clients; the budget override rides along with the key lookup so checking it costs no extra read.
 */
export interface AuthedMember extends Member {
  writeBudgetOverride: { rows: number; until: string | null } | null;
}

export function publicMember(member: Member): Member {
  return { id: member.id, displayName: member.displayName };
}

/** 32 random bytes, base64url-encoded. Only the SHA-256 hash is stored. */
export function generateApiKey(): string {
  return KEY_PREFIX + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function generateSessionToken(): string {
  return SESSION_PREFIX + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : null;
}

/**
 * Browser session cookie. It holds a session token (see createSession), never the API key, so a
 * stolen cookie can read for at most 30 days and can't upload. `__Host-` forces Secure, Path=/ and
 * no Domain, so it can't be set or read by other subdomains. HttpOnly keeps it away from page
 * scripts. SameSite=Strict keeps it off cross-site requests.
 */
export const SESSION_COOKIE = "__Host-fchub_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Signing in on more devices than this ends the oldest sessions. */
export const MAX_SESSIONS_PER_MEMBER = 10;

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Looks up an active member by API key. */
export async function memberForKey(db: SqlDatabase, key: string | null): Promise<AuthedMember | null> {
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const row = await db
    .prepare(
      `SELECT id, display_name, write_budget_override, write_budget_override_until
       FROM members WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await hashKey(key))
    .first<{ id: number; display_name: string; write_budget_override: number | null; write_budget_override_until: string | null }>();
  return row ? { id: row.id, displayName: row.display_name, writeBudgetOverride: writeBudgetOverrideOf(row) } : null;
}

export function writeBudgetOverrideOf(row: {
  write_budget_override: number | null;
  write_budget_override_until: string | null;
}): AuthedMember["writeBudgetOverride"] {
  return row.write_budget_override === null ? null : { rows: row.write_budget_override, until: row.write_budget_override_until };
}

/** Looks up the active member behind an unexpired browser session token. */
export async function memberForSession(db: SqlDatabase, token: string | null, now: Date): Promise<AuthedMember | null> {
  if (!token?.startsWith(SESSION_PREFIX)) return null;
  const row = await db
    .prepare(
      `SELECT m.id, m.display_name, m.write_budget_override, m.write_budget_override_until
       FROM sessions s JOIN members m ON m.id = s.member_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND m.revoked_at IS NULL`,
    )
    .bind(await hashKey(token), now.toISOString())
    .first<{ id: number; display_name: string; write_budget_override: number | null; write_budget_override_until: string | null }>();
  return row ? { id: row.id, displayName: row.display_name, writeBudgetOverride: writeBudgetOverrideOf(row) } : null;
}

/**
 * Starts a browser session for a member who just proved they hold their key, and returns the
 * token for the cookie. Also clears expired sessions and keeps at most MAX_SESSIONS_PER_MEMBER
 * per member, so the table can't grow without bound.
 */
export async function createSession(db: SqlDatabase, memberId: number, now: Date): Promise<string> {
  const token = generateSessionToken();
  const expires = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
    db
      .prepare("INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await hashKey(token), memberId, now.toISOString(), expires),
    db
      .prepare(
        `DELETE FROM sessions WHERE member_id = ?1 AND token_hash NOT IN (
           SELECT token_hash FROM sessions WHERE member_id = ?1 ORDER BY created_at DESC LIMIT ?2)`,
      )
      .bind(memberId, MAX_SESSIONS_PER_MEMBER),
  ]);
  return token;
}

/** Signs a browser out (the cookie's session stops working even if the cookie is kept). */
export async function deleteSession(db: SqlDatabase, token: string | null): Promise<void> {
  if (!token?.startsWith(SESSION_PREFIX)) return;
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await hashKey(token))
    .run();
}

/** Ends every browser session of a member (their key was rotated or revoked). */
export function endSessions(db: SqlDatabase, memberId: number): SqlStatement {
  return db.prepare("DELETE FROM sessions WHERE member_id = ?").bind(memberId);
}

/**
 * Resolves the caller to an active member. The bearer header (API key) always works; the session
 * cookie only when `allowCookie` is set, which we do for read-only GET routes. Anything that
 * changes data needs the header, which a cross-site page can't attach, so cookies can't be used
 * for CSRF.
 */
export async function authenticateMember(db: SqlDatabase, request: Request, now: Date, allowCookie = false): Promise<AuthedMember | null> {
  const bearer = bearerToken(request);
  if (bearer) return memberForKey(db, bearer);
  return allowCookie ? memberForSession(db, readCookie(request, SESSION_COOKIE), now) : null;
}

/** Constant-time comparison for the admin token, so response timing doesn't leak it. */
export async function isAdmin(request: Request, adminToken: string | undefined): Promise<boolean> {
  const token = bearerToken(request);
  if (!adminToken || !token) return false;
  const [a, b] = await Promise.all([hashKey(token), hashKey(adminToken)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Gives an active member a new key and invalidates the old one at once. The member row stays the
 * same, so their characters, retainers and history stay theirs (revoking and re-creating would
 * leave their characters registered to the old member). Returns null if there's no such active member.
 */
export async function rotateMemberKey(db: SqlDatabase, memberId: number): Promise<string | null> {
  const apiKey = generateApiKey();
  // A rotated key may have leaked, so any browser signed in with it is signed out too.
  const [updated] = (await db.batch([
    db.prepare("UPDATE members SET key_hash = ? WHERE id = ? AND revoked_at IS NULL").bind(await hashKey(apiKey), memberId),
    endSessions(db, memberId),
  ])) as { meta: { changes: number } }[];
  return (updated?.meta.changes ?? 0) > 0 ? apiKey : null;
}

export async function createMember(db: SqlDatabase, displayName: string): Promise<{ member: Member; apiKey: string }> {
  const apiKey = generateApiKey();
  const result = await db
    .prepare("INSERT INTO members (display_name, key_hash, created_at) VALUES (?, ?, ?)")
    .bind(displayName, await hashKey(apiKey), new Date().toISOString())
    .run();
  return { member: { id: result.meta.last_row_id, displayName }, apiKey };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
