import { join } from "node:path";
import { type AppEnv, handle } from "../src/app.ts";
import type { Fetcher } from "../src/icons.ts";
import type { Upload, UploadItem, UploadOwner } from "../src/contract.ts";
import { applyMigrations } from "../src/db/migrate.ts";
import { NodeSqliteDatabase } from "../src/db/sqlite.ts";

export const ADMIN_TOKEN = "test-admin-token";

export type TestEnv = AppEnv & { DB: NodeSqliteDatabase };

export function createEnv(): TestEnv {
  const db = new NodeSqliteDatabase(":memory:");
  applyMigrations(db, join(import.meta.dirname, "..", "migrations"));
  return { DB: db, ADMIN_TOKEN };
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
}

/** A test env with limit overrides applied, as wrangler.toml [vars] would (see src/limits.ts). */
export function envWith(vars: Partial<Record<`LIMIT_${string}` | "WRITES_ENABLED", string>>): TestEnv {
  return Object.assign(createEnv(), vars);
}

/** Rows inserted, updated or deleted on this connection so far (SQLite's own counter). */
export function totalChanges(env: TestEnv): number {
  return Number((env.DB.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
}

/** Stands in for XIVAPI: every icon is a (tiny) PNG. */
export const fakeIconFetch: Fetcher = async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

/** The raw Response, for status/headers or non-JSON bodies (icons); call() parses JSON. */
export function send(env: AppEnv, method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined = options.rawBody;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return handle(new Request(`http://test.local${path}`, { method, headers, body }), env);
}

export async function call(env: AppEnv, method: string, path: string, options: CallOptions = {}): Promise<{ status: number; body: any }> {
  const response = await send(env, method, path, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function addMember(env: AppEnv, displayName: string): Promise<string> {
  const res = await call(env, "POST", "/api/v1/admin/members", { token: ADMIN_TOKEN, body: { displayName } });
  if (res.status !== 201) throw new Error(`addMember failed: ${JSON.stringify(res.body)}`);
  return res.body.apiKey as string;
}

export function item(itemId: number, name: string, quantity: number, location: string, extra: Partial<UploadItem> = {}): UploadItem {
  return {
    itemId,
    name,
    iconId: 1000 + itemId,
    quantity,
    isHq: false,
    isCollectable: false,
    container: 0,
    sortedContainer: 0,
    sortedSlot: 0,
    location,
    ...extra,
  };
}

export function upload(contentId: string, name: string, owners: UploadOwner[], capturedAt = new Date().toISOString()): Upload {
  return {
    schemaVersion: 2,
    pluginVersion: "test",
    capturedAt,
    character: { contentId, name, homeWorldId: 409, homeWorld: "Kraken" },
    owners,
  };
}

// Synthetic ids, shaped like the real ones (64-bit decimal strings).
export const ALICE = "18014498500000001";
export const ALICE_RETAINER = "33777097200000001";
export const BOB = "18014498500000002";
export const FC = "9280933600000000001";
