# FC Hub web API

Stores inventory snapshots uploaded by the FC Hub plugin and answers "who has this item, how many, and where?", through a JSON API and a small web UI (`public/`).

- Zero runtime dependencies: web-standard `Request`/`Response` and plain SQL. See [ADR 0002](../docs/adr/0002-zero-dependency-backend.md).
- Runs on **Cloudflare Workers + D1** (`src/worker.ts`) or **Node 22.18+ with built-in SQLite** (`src/node.ts`).

## Develop

```bash
cd web
npm test               # node:test suite, in-memory SQLite, no install needed
npm install            # only needed for typecheck / wrangler
npm run typecheck

# Run locally on Node with a SQLite file (applies migrations automatically)
ADMIN_TOKEN=dev-admin npm start          # API + UI on http://localhost:8787
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
npm run deploy                            # prints the https://fc-hub.<you>.workers.dev URL
```

Then create a key for each FC member (the key is shown **once**):

```bash
curl -X POST https://fc-hub.<you>.workers.dev/api/v1/admin/members \
  -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"displayName":"Danny"}'
```

## API

All `/api/v1` routes except admin take `Authorization: Bearer <member key>`. The read-only `GET` routes (`me`, `search`, `overview`) also accept the browser session cookie. Errors look like `{"error":{"code","message","details?"}}`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Web UI (search + "who's uploaded"); static files from `public/` |
| `POST` | `/api/v1/session` | Browser sign-in: `{"apiKey"}` → HttpOnly session cookie |
| `DELETE` | `/api/v1/session` | Sign out |
| `GET` | `/healthz` | Liveness |
| `GET` | `/api/v1/me` | The key's member and their characters (plugin "Test connection") |
| `POST` | `/api/v1/snapshots` | Upload changed sections (JSON, optionally `Content-Encoding: gzip`, ≤ 8 MB decompressed) |
| `GET` | `/api/v1/search?q=` | Items by name substring or exact item id, grouped item → owner → locations |
| `GET` | `/api/v1/overview` | Every character's owners and per-section freshness |
| `POST` | `/api/v1/admin/members` | Create a member, returns their key once (admin token) |
| `POST` | `/api/v1/admin/members/:id/revoke` | Revoke a member's key (admin token) |

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

## Web UI

Sign in with your personal key (the same one the plugin uses). The server stores it in a `__Host-` cookie that is `HttpOnly`, `Secure` and `SameSite=Strict`, so page scripts can't read it and other sites can't send it. Search is by name or item id, with results grouped item → holder → slot, and stale data (older than 7 days) highlighted. **Who's uploaded** shows how fresh each character's, retainer's and FC chest's data is.

## Security notes

- Member keys are 256-bit random values with an `fch_` prefix, stored only as SHA-256 hashes. The admin token is compared in constant time.
- Upload bodies are size-capped *after* decompression (gzip-bomb safe) and strictly validated.
- Browser sessions can only **read**. Uploads and admin actions need the `Authorization` header, which another site can't attach, so the cookie can't be abused for CSRF. Session endpoints also reject foreign `Origin`s.
- Every response carries a strict Content-Security-Policy (`default-src 'none'`, same-origin scripts/styles only, no inline code, `frame-ancestors 'none'`), plus `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, COOP and (on https) HSTS. API responses are `no-store`.
- The UI renders all data with `textContent`, never `innerHTML`.
- Planned: Cloudflare Access (zero trust) in front of the web UI, and `workers_dev = false` once a custom domain is in place.
