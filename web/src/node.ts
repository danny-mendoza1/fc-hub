/**
 * Node entry point (local dev without Cloudflare, and the future Docker image).
 *
 *   FC_HUB_DB=./fc-hub.sqlite ADMIN_TOKEN=... PORT=8787 node src/node.ts
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "./app.ts";
import { applyMigrations } from "./db/migrate.ts";
import { NodeSqliteDatabase } from "./db/sqlite.ts";
import { startServer } from "./node-server.ts";
import { diskAssets } from "./static.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.FC_HUB_DB ?? "fc-hub.sqlite";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const db = new NodeSqliteDatabase(dbPath);
const applied = applyMigrations(db, join(webRoot, "migrations"));
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);

// Limit overrides (LIMIT_*, WRITES_ENABLED) come from the environment, as [vars] do on Workers.
const env: AppEnv = { ...process.env, DB: db, ADMIN_TOKEN: process.env.ADMIN_TOKEN, ASSETS: diskAssets(join(webRoot, "dist")) };

startServer(env, port, host, () => console.log(`FC Hub listening on http://${host}:${port} (db: ${dbPath})`));
