/**
 * Node entry point (local dev without Cloudflare, and the future Docker image).
 *
 *   FC_HUB_DB=./fc-hub.sqlite ADMIN_TOKEN=... PORT=8787 node src/node.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type AppEnv, handle } from "./app.ts";
import { applyMigrations } from "./db/migrate.ts";
import { NodeSqliteDatabase } from "./db/sqlite.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.FC_HUB_DB ?? "fc-hub.sqlite";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const db = new NodeSqliteDatabase(dbPath);
const applied = applyMigrations(db, migrationsDir);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);

const env: AppEnv = { DB: db, ADMIN_TOKEN: process.env.ADMIN_TOKEN };

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const response = await handle(toRequest(req), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
});

server.listen(port, host, () => console.log(`FC Hub listening on http://${host}:${port} (db: ${dbPath})`));

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // Required by Node's fetch implementation when streaming a request body.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}
