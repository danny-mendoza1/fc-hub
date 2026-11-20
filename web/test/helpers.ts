import { join } from "node:path";
import { type AppEnv, handle } from "../src/app.ts";
import type { Upload, UploadItem, UploadOwner } from "../src/contract.ts";
import { applyMigrations } from "../src/db/migrate.ts";
import { NodeSqliteDatabase } from "../src/db/sqlite.ts";

export const ADMIN_TOKEN = "test-admin-token";

export function createEnv(): AppEnv & { DB: NodeSqliteDatabase } {
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

export async function call(env: AppEnv, method: string, path: string, options: CallOptions = {}): Promise<{ status: number; body: any }> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined = options.rawBody;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const response = await handle(new Request(`http://test.local${path}`, { method, headers, body }), env);
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
