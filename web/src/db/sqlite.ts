import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDatabase, SqlRunResult, SqlStatement, SqlValue } from "./types.ts";

/** node:sqlite implementation of the D1-shaped {@link SqlDatabase} interface. */
export class NodeSqliteDatabase implements SqlDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL;");
    }
  }

  prepare(sql: string): SqlStatement {
    return new NodeSqliteStatement(this.raw, sql, []);
  }

  async batch(statements: SqlStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    this.raw.exec("BEGIN");
    try {
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
    return results;
  }

  close(): void {
    this.raw.close();
  }
}

class NodeSqliteStatement implements SqlStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly values: SqlValue[];

  constructor(db: DatabaseSync, sql: string, values: SqlValue[]) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: SqlValue[]): SqlStatement {
    return new NodeSqliteStatement(this.db, this.sql, values);
  }

  private statement(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async first<T>(): Promise<T | null> {
    const row = this.statement().get(...this.values);
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement().all(...this.values) as T[] };
  }

  async run(): Promise<SqlRunResult> {
    const result = this.statement().run(...this.values);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}
