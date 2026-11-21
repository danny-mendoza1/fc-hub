# FC Hub web

Stores inventory snapshots uploaded by the FC Hub plugin and answers "who has this item, how many, and where?", through a JSON API and a React web UI.

| Path | What |
|---|---|
| `src/` | API: zero runtime dependencies, web-standard `Request`/`Response` and plain SQL ([ADR 0002](../docs/adr/0002-zero-dependency-backend.md)). Runs on **Cloudflare Workers + D1** (`worker.ts`) or **Node 22.18+ with built-in SQLite** (`node.ts`) |
| `src/api-types.ts` | Response types shared with the client |
| `client/` | React 19 + TypeScript + CSS Modules UI, built by Vite into `dist/` ([ADR 0003](../docs/adr/0003-react-client.md)) |
| `migrations/` | SQL migrations (D1 and Node) |
| `test/` | `node:test` suites for the API and the built client |

## Develop

```bash
cd web
npm install
npm run typecheck      # API and client
npm run build          # client -> dist/
npm test               # API tests + built-client tests (in-memory SQLite)

# API + built UI on Node with a SQLite file (applies migrations automatically)
ADMIN_TOKEN=dev-admin npm start          # http://localhost:8787

# While working on the UI: hot reload on :5173, proxying /api to the server above
npm run dev:ui                           # http://localhost:5173
```

Use `localhost` rather than `127.0.0.1` in the browser so the `Secure` session cookie is accepted over plain http.

PowerShell: `$env:ADMIN_TOKEN="dev-admin"; npm start`.

## Deploy to Cloudflare (first time)

```bash
cd web
npm install
npx wrangler login
npx wrangler d1 create fc-hub            # copy the printed database_id into wrangler.toml
npm run db:migrate:remote                 # creates the tables in D1
npx wrangler secret put ADMIN_TOKEN       # paste a long random string; keep it in your password manager
npm run deploy                            # builds the client, then prints the https://fc-hub.<you>.workers.dev URL
```

Then create a key for each FC member (the key is shown **once**):

```bash
curl -X POST https://fc-hub.<you>.workers.dev/api/v1/admin/members \
  -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"displayName":"Danny"}'
```

If a key leaks or is lost, rotate it rather than revoking it: the member keeps their characters, the old key stops working at once, and the new key is shown **once**. They paste it into `/fchub config` and sign in on the website again.

```bash
curl -X POST https://fc-hub.<you>.workers.dev/api/v1/admin/members/<id>/rotate-key \
  -H "authorization: Bearer <ADMIN_TOKEN>"
```

Member ids are in `GET /api/v1/admin/usage`. Revoke (`…/revoke`) is for someone leaving the FC.

## API

All `/api/v1` routes except admin take `Authorization: Bearer <member key>`. The read-only `GET` routes (`me`, `search`, `overview`, `owners/:id/items`, `owners/:id/also-in`, `items/in-common`, `icons/:id`, `wondrous-tails`) also accept the browser session cookie. Errors look like `{"error":{"code","message","details?"}}`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Web UI (search + "who's uploaded"), served from the built `dist/` |
| `POST` | `/api/v1/session` | Browser sign-in: `{"apiKey"}` → HttpOnly cookie holding a 30-day session token (not the key) |
| `DELETE` | `/api/v1/session` | Sign out (ends the session on the server too) |
| `GET` | `/healthz` | Liveness |
| `GET` | `/api/v1/me` | The key's member and their characters (plugin "Test connection") |
| `POST` | `/api/v1/snapshots` | Upload changed sections (JSON, optionally `Content-Encoding: gzip`, ≤ 4 MB decompressed); counts against the daily write budget |
| `GET` | `/api/v1/search?q=` | Items by name substring or exact item id, grouped item → owner → locations |
| `GET` | `/api/v1/overview` | Every character's owners and per-section freshness |
| `GET` | `/api/v1/owners/:ownerId/items` | One owner's items by section in bag/slot order (the "Who's uploaded" accordions) |
| `GET` | `/api/v1/owners/:ownerId/also-in` | Every storage place of each item (+HQ) this owner holds (the "Also in" lines) |
| `GET` | `/api/v1/items/in-common` | Holders (members, FC chest, houses) and the items two or more of them store; the party is chosen in the browser |
| `GET` | `/api/v1/icons/:iconId` | Item icon PNG, proxied from XIVAPI (see below) |
| `POST` | `/api/v1/wondrous-tails` | Plugin upload of the member's Wondrous Tails journal (bearer key only); counts against the daily write budget |
| `GET` | `/api/v1/wondrous-tails` | Every member's journal with this week's status; "in common" is computed in the browser |
| `POST` | `/api/v1/admin/members` | Create a member, returns their key once (admin token) |
| `POST` | `/api/v1/admin/members/:id/revoke` | Revoke a member's key (admin token) |
| `POST` | `/api/v1/admin/members/:id/rotate-key` | Give a member a new key (returned once); the old key stops working, characters stay theirs (admin token) |
| `GET` | `/api/v1/admin/usage` | Today's rows written per member against the budgets, and the limits in force (admin token) |
| `PUT` | `/api/v1/admin/members/:id/write-budget` | Override one member's daily write budget, optionally until a time (admin token) |

### Upload contract (schema v2)

```jsonc
{
  "schemaVersion": 2,
  "pluginVersion": "0.2.0.0",
  "capturedAt": "2026-11-20T18:20:42Z",
  "character": { "contentId": "1801…", "name": "…", "homeWorldId": 409, "homeWorld": "Kraken" },
  "owners": [
    {
      "ownerId": "3377…", "kind": "retainer", "name": "Sir-noodle",
      "sections": [
        { "section": "RetainerBags", "items": [ { "itemId": 5057, "name": "Iron Ore", "iconId": 21204,
          "quantity": 99, "isHq": false, "isCollectable": false, "container": 10000,
          "sortedContainer": 10000, "sortedSlot": 0, "location": "Retainer · page 1 · slot 1" } ] }
      ]
    }
  ]
}
```

Merge rules (`src/ingest.ts`):

- Each section that's sent **replaces** that owner's section; `items: []` empties it. Sections and owners that aren't sent are left alone, so retainers you haven't opened this session keep their last-known contents.
- A section is skipped if the server already holds a newer capture of it, e.g. an FC mate opened the FC chest after you.
- A character belongs to the member whose key first uploaded it. Characters and retainers can only be updated by their own character. The FC chest and houses are shared, and the latest capture wins.
- 64-bit ids are decimal strings.

## Limits (cost guards)

D1 bills every row written, and Cloudflare's spending limit doesn't cover D1, so the app enforces its own ceiling ([ADR 0005](../docs/adr/0005-cost-guards.md)). Defaults live in `src/limits.ts`:

| Limit | Default | Override variable |
|---|---|---|
| Rows written per member per UTC day | 300,000 | `LIMIT_MEMBER_DAILY_WRITE_ROWS` |
| Rows written per UTC day, whole site | 1,000,000 (≈ 30M/month, under the 50M included) | `LIMIT_SITE_DAILY_WRITE_ROWS` |
| Upload body (after gzip) | 4 MB | `LIMIT_MAX_BODY_BYTES` |
| Owners / sections per owner / items per section / items per upload | 24 / 32 / 2,000 / 10,000 | `LIMIT_OWNERS_PER_UPLOAD`, `LIMIT_SECTIONS_PER_OWNER`, `LIMIT_ITEMS_PER_SECTION`, `LIMIT_ITEMS_PER_UPLOAD` |
| New owners one character may create | 24 | `LIMIT_OWNERS_PER_CHARACTER` |
| Uploads allowed at all | yes | `WRITES_ENABLED = "false"` (read-only mode) |

- **Change a limit for everyone:** uncomment `[vars]` in `wrangler.toml`, set the value, `npm run deploy`. Values that aren't positive whole numbers are ignored with a warning, so a typo can't switch a guard off.
- **Change one member's budget, no deploy:**
  ```bash
  curl -X PUT https://fc-hub.<you>.workers.dev/api/v1/admin/members/2/write-budget \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
    -d '{"dailyWriteRows":2000000,"until":"2026-11-23T00:00:00Z"}'   # {"dailyWriteRows":null} clears it
  ```
- **See today's usage:** `curl https://fc-hub.<you>.workers.dev/api/v1/admin/usage -H "Authorization: Bearer $ADMIN_TOKEN"`.
- **Over budget:** uploads get `429` (or `503` in read-only mode) with `Retry-After` until 00:00 UTC; the plugin shows the message and waits. Reads are never limited.
- **Every route declares its policy** in `src/app.ts` (`access`, `writes: "none" | "metered" | "admin"`). `GET` routes can only be `"none"`, and their handlers get a database that throws on any write. `test/cost-guards.test.ts` calls every `GET` route and fails if one writes.

## Web UI

Sign in with your personal key (the same one the plugin uses). The server checks it and sets a `__Host-` cookie holding a random 30-day **session token**, never the key itself ([ADR 0007](../docs/adr/0007-session-tokens.md)). The cookie is `HttpOnly`, `Secure` and `SameSite=Strict`, so page scripts can't read it and other sites can't send it. Signing out, rotating the key or revoking the member ends the session on the server. Search is by name or item id, with results grouped item → holder → slot and stale data (older than 7 days) highlighted. **Who's uploaded** shows how fresh each character's, retainer's, FC chest's and house's data is, and every row expands into its sections (Inventory, Armoury chest, Retainer bags…) and then the items with icons and exact slots, loaded on demand.

### Wondrous Tails

One journal per member. The plugin shares the first character it sees, changeable in `/fchub config`. `src/wondrous-tails.ts` holds the rules and is shared with the UI:

- Weekly reset is Tuesdays 08:00 UTC. A journal lasts two weeks from the reset after it was issued, so its expiry tells **this week's** book (expires the reset after next) from **last week's** (expires at the coming reset).
- A still-valid journal that disappears between uploads is recorded as **turned in**. Statuses age with time, so a book uploaded last week shows as last week's without a new upload, and data captured before this week's reset is flagged.
- **Duties in common**: exact objective matches across the members you pick, listing who still needs each duty and who's done it (with their second chances).

## Security notes

- Member keys are 256-bit random values with an `fch_` prefix, stored only as SHA-256 hashes. The admin token is compared in constant time.
- Upload bodies are size-capped *after* decompression (gzip-bomb safe) and strictly validated, and every upload is charged to a daily write budget (see Limits).
- Revoking a member hides their characters, retainers and uploads everywhere at once: reads build on the shared SQL in `src/db/scopes.ts`, and `test/visibility.test.ts` checks every read route for leaks.
- Browser sessions can only **read**, and the cookie holds a session token rather than the key, so a stolen cookie can't upload and stops working when the member signs out, the key is rotated or the member is revoked. Uploads and admin actions need the `Authorization` header, which another site can't attach, so the cookie can't be abused for CSRF. Session endpoints also reject foreign `Origin`s.
- Every response carries a strict Content-Security-Policy (`default-src 'none'`, same-origin scripts/styles only, no inline code, `frame-ancestors 'none'`), plus `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, COOP and (on https) HSTS. API responses are `no-store`.
- The UI is React, which escapes rendered text; `dangerouslySetInnerHTML` is never used. Vite's build has no inline scripts (a test checks `dist/index.html`), so the CSP needs no `unsafe-inline`.
- Content-hashed `/assets/*` are cached `immutable`; `index.html` is `no-cache`.
- **Item icons** come from [XIVAPI](https://v2.xivapi.com)'s asset endpoint (`ui/icon/{group}/{id}_hr1.tex` → PNG) through `/api/v1/icons/:iconId`, so the CSP stays `img-src 'self'` and members' browsers never contact a third party. It is not an open proxy: members only, numeric ids only, PNG responses only, size-capped; successes are cached privately for 30 days and failures aren't cached.
- Planned: Cloudflare Access (zero trust) in front of the web UI, and `workers_dev = false` once a custom domain is in place.
