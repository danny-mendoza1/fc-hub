import { DELETE_REMOVED_SQL, INSERT_ADDED_SQL } from "../src/ingest.ts";

/**
 * The diff-ingest statements with harmless literals: a section that doesn't exist and no items.
 * Running this file against D1 proves it accepts the SQL while writing zero rows.
 */
export function preflightSql(): string {
  const bind = (sql: string) =>
    sql
      .replaceAll("?1", "'__preflight__'")
      .replaceAll("?2", "'__preflight__'")
      .replaceAll("?3", "'[]'")
      .replaceAll("?4", "'__preflight__'")
      .replaceAll("?5", "'__preflight__'");
  return [
    "-- No-op check that D1 accepts the diff-ingest SQL (web/src/ingest.ts). Writes nothing.",
    "-- Generated: keep in sync via test/ingest.test.ts. Run: npm run db:preflight:remote",
    `${bind(DELETE_REMOVED_SQL).trim()};`,
    `${bind(INSERT_ADDED_SQL).trim()};`,
    "",
  ].join("\n");
}
