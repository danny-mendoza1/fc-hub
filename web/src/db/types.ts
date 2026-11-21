/**
 * The slice of Cloudflare D1's API that FC Hub uses. D1 satisfies it natively; the Node
 * build implements it on top of node:sqlite (see ./sqlite.ts). Keeping to this interface
 * is what lets the same app code run on Workers and in Docker.
 */
export type SqlValue = string | number | null;

export interface SqlRunResult {
  /**
   * D1 also reports `rows_read` / `rows_written` (what it bills, index rows included);
   * node:sqlite doesn't, so they're optional. See db/guards.ts.
   */
  meta: { changes: number; last_row_id: number; rows_read?: number; rows_written?: number };
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<SqlRunResult>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** Runs all statements in one transaction; any failure rolls back the whole batch. */
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}
