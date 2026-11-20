# ADR 0002: Zero-dependency web backend

- **Status:** Accepted. Supersedes the *Hono + Drizzle* part of [ADR 0001](0001-architecture.md) decision 2.
- **Date:** 2026-11-20

## Context

ADR 0001 picked Hono (HTTP) and Drizzle (SQL) so one codebase could run on Cloudflare Workers + D1 now and in Docker later. When we started building, three things changed the trade-off:

- The API is small: upload, search, overview, a handful of admin routes. A router is ~30 lines.
- Both target runtimes already speak the same standards. Workers and Node 22 both have `Request`/`Response`, Web Crypto, `DecompressionStream`, and a SQLite engine (D1 / built-in `node:sqlite`).
- Every runtime dependency is supply-chain surface in a service that holds API keys. We also want CI and local tests to run with no `npm install`.

## Decision

- **HTTP:** a web-standard `handle(Request, env) → Response` function (`web/src/app.ts`). Two thin entry points wrap it: `worker.ts` (Cloudflare) and `node.ts` (`node:http`, for local dev and Docker).
- **SQL:** plain, hand-written SQL against a small D1-shaped interface (`web/src/db/types.ts`). D1 satisfies it natively; `db/sqlite.ts` adapts `node:sqlite`. Migrations are plain `.sql` files, applied by `wrangler d1 migrations apply` on Cloudflare and by `db/migrate.ts` on Node, both tracked in the same `d1_migrations` table.
- **Tooling only as dev dependencies:** `typescript`, `@types/node`, `wrangler`. Tests use `node:test` and run TypeScript directly through Node's type stripping.

## Consequences

- No runtime dependencies to audit or update; tests and the type check run in CI without installing anything except TypeScript.
- We own the router, validation and SQL. That's acceptable at this size. If the API grows a lot, revisit Hono, which runs on both targets.
- Code is limited to erasable TypeScript syntax (no enums or parameter properties), enforced by `erasableSyntaxOnly`.
- D1 limits shape the writes: an upload is one transactional `batch()` (counts as one query), and items are bulk-inserted with `INSERT … SELECT … FROM json_each(?)` in 2,000-item chunks. Search uses `instr()` rather than `LIKE`, avoiding D1's 50-byte pattern limit and wildcard escaping.
