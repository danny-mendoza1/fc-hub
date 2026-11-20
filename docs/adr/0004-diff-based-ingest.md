# ADR 0004: Write only changed rows on upload

- **Status:** Accepted. Changes the "per-section replace" storage step of the upload contract (the contract itself is unchanged).
- **Date:** 2026-11-20

## Context

On 2026-11-20 the account hit D1's free-tier limit of 100,000 rows written per day. Since 2026-09-01, free-tier D1 queries fail once the limit is reached, until 00:00 UTC.

The cause was our ingest. When a section changed, the server deleted every row of that section and inserted every row again. D1 bills each row written plus one extra write per index the row touches, and `items` has two indexes. A 140-slot inventory bag therefore cost about 140 × 6 ≈ 840 rows written whenever a single stack changed. With a 5-second upload debounce, an hour of gathering, crafting or retainer selling by three players used up the whole day.

We moved to Workers Paid ($5/month, 50M rows written included) to keep running. The ingest still needed fixing, both for cost and because the same pattern would cause needless disk churn on a self-hosted SQLite.

## Decision

The server syncs each uploaded section as a **multiset diff**, in two statements per section that run inside the existing single-transaction batch (`syncSectionItems` in `web/src/ingest.ts`):

1. **Delete** stored rows with no identical uploaded row.
2. **Insert** uploaded rows with no identical stored row.

"Identical" means every item column is equal. Repeated identical rows are numbered with `row_number()`, so two identical stacks stay two rows, and dropping one of them deletes exactly one row.

The uploaded items are bound once per statement as a compact JSON array of arrays. If that JSON could come near D1's 2 MB bound-value limit (more than 600k characters), the server falls back to the old replace-all path for that section. Real sections are around 10–50 KB.

The plugin and the upload contract are unchanged.

## Consequences

- **Cost:** one changed stack now costs 2 item rows (delete + insert) plus the character, owner and section upserts: 5 rows changed, about 10 rows written with index updates, instead of about 845. An unchanged re-upload writes no item rows.
- **Correctness:** both statements run in the same transaction, so concurrent uploads of a shared section (FC chest, houses) can't interleave mid-diff. Tests cover changed stacks, moved stacks, identical stacks, emptying a section, alternating FC-chest uploads and the oversized fallback (`web/test/ingest.test.ts`).
- **Reads:** a diff reads the section's stored rows. D1 includes 25 billion rows read per month on the paid plan, so this cost is negligible.
- **Portability:** the SQL uses window functions and `WITH` before `DELETE`/`INSERT`, both core SQLite features available in D1 and `node:sqlite`. `npm run db:preflight:remote` runs the exact statements as a no-op against the real database before deploying.
