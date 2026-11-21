import type { SqlDatabase, SqlRunResult, SqlStatement, SqlValue } from "./types.ts";

/**
 * Statements that change the database. Matched on whole words, so columns like `updated_at` or
 * `deleted` don't trip it; app SQL never carries user text (values are always bound).
 */
const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|REINDEX)\b/i;

export class ReadOnlyViolation extends Error {}

/**
 * The database as routes declared `writes: "none"` see it: reads work, anything that would write
 * throws before reaching D1. This is what makes "GET requests cost no writes" a guarantee rather
 * than a convention (ADR 0005).
 */
export function readOnly(db: SqlDatabase): SqlDatabase {
  return {
    prepare(sql: string): SqlStatement {
      if (WRITE_SQL.test(sql)) throw new ReadOnlyViolation(`Write attempted on a read-only route: ${sql.trim().slice(0, 80)}`);
      return db.prepare(sql);
    },
    batch(): Promise<unknown[]> {
      throw new ReadOnlyViolation("batch() attempted on a read-only route");
    },
  };
}

/** Rows a statement wrote: D1 reports index rows too; node:sqlite only reports changed rows. */
export function rowsWrittenBy(result: unknown): number {
  const meta = (result as { meta?: Partial<SqlRunResult["meta"]> } | null)?.meta;
  return meta?.rows_written ?? meta?.changes ?? 0;
}

/** Counts the rows every write through it costs, so the request can be charged to a budget. */
export class MeteredDatabase implements SqlDatabase {
  rowsWritten = 0;
  readonly inner: SqlDatabase;

  constructor(inner: SqlDatabase) {
    this.inner = inner;
  }

  prepare(sql: string): SqlStatement {
    return new MeteredStatement(this, this.inner.prepare(sql));
  }

  async batch(statements: SqlStatement[]): Promise<unknown[]> {
    const results = await this.inner.batch(statements.map((s) => (s instanceof MeteredStatement ? s.inner : s)));
    for (const result of results) this.rowsWritten += rowsWrittenBy(result);
    return results;
  }
}

class MeteredStatement implements SqlStatement {
  readonly db: MeteredDatabase;
  readonly inner: SqlStatement;

  constructor(db: MeteredDatabase, inner: SqlStatement) {
    this.db = db;
    this.inner = inner;
  }

  bind(...values: SqlValue[]): SqlStatement {
    return new MeteredStatement(this.db, this.inner.bind(...values));
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.inner.first<T>();
  }

  all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return this.inner.all<T>();
  }

  async run(): Promise<SqlRunResult> {
    const result = await this.inner.run();
    this.db.rowsWritten += rowsWrittenBy(result);
    return result;
  }
}
