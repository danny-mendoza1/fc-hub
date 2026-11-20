import type { SqlDatabase } from "./db/types.ts";

/** Prefix makes keys recognisable (and greppable by secret scanners) if one ever leaks. */
const KEY_PREFIX = "fch_";

export interface Member {
  id: number;
  displayName: string;
}

/** 32 random bytes, base64url-encoded. Only the SHA-256 hash is stored. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return KEY_PREFIX + base64Url(bytes);
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
 * Browser session cookie. `__Host-` forces Secure, Path=/ and no Domain, so it can't be set or
 * read by other subdomains. HttpOnly keeps it away from page scripts. SameSite=Strict keeps it
 * off cross-site requests.
 */
export const SESSION_COOKIE = "__Host-fchub_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function sessionCookie(apiKey: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(apiKey)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Looks up an active member by API key. */
export async function memberForKey(db: SqlDatabase, key: string | null): Promise<Member | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const row = await db
    .prepare("SELECT id, display_name FROM members WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await hashKey(key))
    .first<{ id: number; display_name: string }>();
  return row ? { id: row.id, displayName: row.display_name } : null;
}

/**
 * Resolves the caller to an active member. The bearer header always works; the session cookie
 * only when `allowCookie` is set, which we do for read-only GET routes. Anything that changes
 * data needs the header, which a cross-site page can't attach, so cookies can't be used for CSRF.
 */
export async function authenticateMember(db: SqlDatabase, request: Request, allowCookie = false): Promise<Member | null> {
  const bearer = bearerToken(request);
  if (bearer) return memberForKey(db, bearer);
  return allowCookie ? memberForKey(db, readCookie(request, SESSION_COOKIE)) : null;
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
