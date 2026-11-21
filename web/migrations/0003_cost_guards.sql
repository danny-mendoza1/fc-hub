-- Cost guards (ADR 0005). Safe to apply before deploying the code that uses it: the old code
-- ignores the new table and columns.

-- Rows written per member per UTC day, for the daily write budget. WITHOUT ROWID makes the
-- primary key the table itself, so each upsert writes one row instead of a row plus an index row.
CREATE TABLE usage_daily (
  day           TEXT    NOT NULL,  -- YYYY-MM-DD (UTC)
  member_id     INTEGER NOT NULL REFERENCES members(id),
  rows_written  INTEGER NOT NULL,
  requests      INTEGER NOT NULL,
  PRIMARY KEY (day, member_id)
) WITHOUT ROWID;

-- Per-member budget override set through the admin API; null = use the site default.
ALTER TABLE members ADD COLUMN write_budget_override INTEGER;
ALTER TABLE members ADD COLUMN write_budget_override_until TEXT;  -- null = until cleared

-- Every items row written also wrote this index; it only served reads (search by id, "Also in"),
-- which D1 bills ~1000x cheaper than writes. Dropping it cuts each changed stack from 3 to 2 rows.
DROP INDEX items_by_item;
