# ADR 0005: Enforced cost guards

- **Status:** Accepted. Amended 2026-11-21: the daily budget is a soft limit, not a hard ceiling (see Consequences).
- **Date:** 2026-11-20

## Context

FC Hub runs on Workers Paid: 50M D1 rows written per month included, then $1.00 per million. Reads are about 1,000 times cheaper ($0.001 per million after 25 billion). Cloudflare's spending limit covers Workers and Durable Objects but **not D1**, so nothing outside the app stops a runaway write bill.

Before this change, nothing inside the app did either. The upload limits allowed 64 owners × 32 sections × 10,000 items, bounded in practice only by an 8 MB body: roughly 40,000 items, or about 240,000 rows written for one fully changed upload. A leaked key, a plugin bug that loops, or a new feature that writes more than expected could spend the month's allowance in a few hundred requests, and we'd only find out from a budget alert.

The requirement is that cost stays bounded *as features are added*, so the guard has to be enforced by the code, not by convention.

## Decision

1. **A daily write budget, enforced per request.** Every upload route runs against a metering wrapper that adds up D1's own `rows_written` for each statement. The total is added to `usage_daily` (one row per member per UTC day, `WITHOUT ROWID`, so the ledger costs one row per upload). Before an upload runs, the server refuses it with `429` + `Retry-After` (until 00:00 UTC) if the member or the whole site is over budget. Defaults: 300k rows per member and 1M for the site per day, so at most ~30M a month.
2. **Overrides without code changes.** Every limit is defined once in `web/src/limits.ts`. Site-wide overrides are Worker variables (`[vars]` in `wrangler.toml`). One member's budget can be changed at runtime through `PUT /api/v1/admin/members/:id/write-budget`, with an optional expiry. That override is stored on the member's row, so the existing key lookup returns it at no extra read. `WRITES_ENABLED = "false"` puts the site in read-only mode. An override that isn't a positive whole number is ignored, so a typo can't turn a guard off.
3. **Small requests.** Upload limits are matched to the game (2,000 items per section, 10,000 per upload, 24 owners, 4 MB). New owners per character are capped at 24, so a client can't create unlimited fake retainers.
4. **Every route declares a policy, and the router enforces it.** `route(method, path, { access, writes }, handler)`: `writes` is `"none"`, `"metered"` (uploads; API key only) or `"admin"`. The types only let `GET` routes choose `"none"`. Handlers never see the raw database: `"none"` routes get a wrapper that throws on any write statement, and `"metered"` routes get the metering wrapper. A test calls every `GET` route and fails if one writes, and another checks that only the two upload routes are metered.
5. **No index unless a write path needs it.** Every index costs a row on every write. `items_by_item` only served reads, so it's dropped, and each changed stack costs 2 rows instead of 3.
6. **CPU cap per request** (`[limits] cpu_ms`), against denial-of-wallet on the Workers side.

Alternatives considered:
- A scheduled watchdog that reads D1 usage from Cloudflare's analytics API and flips the site to read-only. It also catches writes made outside the app, but it needs an API token, and analytics lag allows minutes of overshoot. It's a possible later backstop.
- A Durable Object counter: exact under concurrency, but a new service for a handful of members.
- Rate limiting by counters in D1: that would turn requests into paid writes.

## Consequences

- The budget is a **soft limit**, not a hard ceiling. Uploads stop once the ledger shows the day's budget spent, so normal use, a looping plugin, or a feature that writes too much is capped at about the budget (~30M rows a month with default settings). It can be exceeded in these ways:
  - **Concurrent uploads.** The check reads the ledger *before* a request, and the charge is added *after* it. Requests in flight at the same time all pass the same check, so the overshoot is up to one upload's worth of rows (under ~40k) per request in flight. The plugin sends one upload at a time, so with a handful of members this is a few hundred thousand rows at most. A leaked key used by a script sending many requests in parallel could overshoot by more before the first charges land. Revoke the key, or set `WRITES_ENABLED = "false"`.
  - **Charging happens after the upload commits, as a separate statement.** If the charge fails, the upload stays stored, its rows go uncounted, and the caller gets a 500. The plugin then retries, which is cheap because the diff writes no item rows for unchanged sections.
  - **Sign-in is not metered.** It writes one or two `sessions` rows, and only after the API key checks out (ADR 0007).
- A hard ceiling would need the charge reserved atomically before the upload runs (for example, a conditional `UPDATE` of `usage_daily` reserving the worst case, then settling the difference). That's not worth an extra write per upload for one FC, so it isn't done.
- Each upload costs one extra row (the ledger). Tests that count writes allow for it (`LEDGER` in `test/ingest.test.ts`).
- On Node (Docker), `node:sqlite` reports changed rows without index rows, so the ledger undercounts there. That's fine: self-hosted SQLite isn't billed per row.
- New routes must pick a policy. A read route that accidentally writes fails in tests and in production (as a 500 with a logged `ReadOnlyViolation`) instead of quietly costing money.
- Deploy order: apply migration `0003_cost_guards.sql` before deploying the code. The old code ignores the new table and columns.
