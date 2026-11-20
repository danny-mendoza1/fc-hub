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

/** Resolves a bearer API key to an active member, or null. */
export async function authenticateMember(db: SqlDatabase, request: Request): Promise<Member | null> {
  const token = bearerToken(request);
  if (!token || !token.startsWith(KEY_PREFIX)) return null;

  const row = await db
    .prepare("SELECT id, display_name FROM members WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await hashKey(token))
    .first<{ id: number; display_name: string }>();
  return row ? { id: row.id, displayName: row.display_name } : null;
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
