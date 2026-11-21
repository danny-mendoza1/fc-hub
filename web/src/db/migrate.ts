import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeSqliteDatabase } from "./sqlite.ts";

/**
 * Applies web/migrations/*.sql in order for the Node build. On Cloudflare the same files are
 * applied with `wrangler d1 migrations apply`, which tracks them in `d1_migrations`;
 * we use the same table name so a database could move between the two.
 */
export function applyMigrations(db: NodeSqliteDatabase, directory: string): string[] {
  db.raw.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)",
  );
  const applied = new Set((db.raw.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));

  const pending = readdirSync(directory)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();

  for (const file of pending) {
    const sql = readFileSync(join(directory, file), "utf8");
    db.raw.exec("BEGIN");
    try {
      db.raw.exec(sql);
      db.raw.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      db.raw.exec("COMMIT");
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }

  return pending;
}
