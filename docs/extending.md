# Adding a feature

How a new kind of shared data (say, dungeon unlocks) goes end to end, using the pieces that already exist. Wondrous Tails is the worked example to copy: it touches every layer once.

## 1. Plugin: read it and send it

| Step | Where | Notes |
|---|---|---|
| Read the game state | `plugin/FcHub/Game/` (like `WondrousTailsReader.cs`) | Read-only. Keep it free of upload logic so it's easy to test. |
| Payload records | `plugin/FcHub/Upload/` (like `WondrousTailsModels.cs`) | Give it a `CurrentSchemaVersion`. Serialize with `UploadJson.Options` (camelCase, enums as strings). |
| Sync loop | `plugin/FcHub/` (like `WondrousTailsSync.cs`) | Read on a timer, hash the payload (ignoring the capture time) and skip unchanged data. **Send through the shared `UploadChannel`**, never your own `HttpClient` call: it handles one-at-a-time, backoff, a rejected key and the server's `Retry-After`. Manual triggers pass `manual: true`. |
| Wire it up | `Plugin.cs` | Construct it with the shared `HubClient` and `UploadChannel`; dispose it. Add it to `/fchub upload` if it should sync on demand. |

## 2. Server: accept it and store it

| Step | Where | Notes |
|---|---|---|
| Validate | `web/src/<feature>.ts` | Build on `Validator` from `validation.ts` (ids, text, ints with ranges, timestamps, enums); clamp the capture time with `clampCapturedAt`. Keep this file browser-safe (no DB or Node imports) so the client can share its types and logic. |
| Store / query | `web/src/<feature>-store.ts` | Take the `SqlDatabase` you're handed; never reach for the raw binding. Show only active members' data: build reads on `FROM_ACTIVE_ITEMS` / `ACTIVE_MEMBER` from `db/scopes.ts`. |
| Table | `web/migrations/NNNN_<feature>.sql` | Every index costs a row on **every write** (ADR 0005); add one only if a write path or a hot read needs it. Prefer one row per member that's replaced in place, like `wondrous_tails`. |
| Routes | `web/src/app.ts` | Declare the policy: the upload is `{ access: "member", writes: "metered" }` (counts against the daily budget), the read is `{ access: "memberOrCookie", writes: "none" }` (gets a read-only database). |
| Types for the client | `web/src/api-types.ts` | Re-export the response types. |

## 3. Website: show it

| Step | Where | Notes |
|---|---|---|
| API call | `web/client/src/api.ts` | Accept an optional `AbortSignal`. |
| Tab | `web/client/src/views.ts` + `App.tsx` | Add it to `VIEWS`; render it in `App`. |
| View | `web/client/src/components/` | Load with `useApi((signal) => api.x(signal), [deps])`; 401s sign out on their own. For "in common" pickers use `usePartySelection` + `<PartyPicker>`, and the shared `inCommonCard` / `rankedList` / `countPill` styles in `ui.module.css`. |

## 4. Tests that come for free, and the ones to add

Already covering a new route without any work:
- `test/cost-guards.test.ts` calls every `GET` route and fails if one writes. If your route has a new path parameter, add a sample value to `SAMPLE_PARAMS`.
- `test/visibility.test.ts` revokes a member and fails if any read route still shows their data.

Add:
- **A contract fixture**: the exact JSON the plugin sends, in `web/test/fixtures/`, accepted by the server in a web test and produced byte-for-byte by the plugin in `plugin/FcHub.Tests` (see the inventory and Wondrous Tails fixtures). This is what catches the C# and TypeScript sides drifting apart.
- **A write-budget scenario**: a typical upload writes at most N rows (see `test/ingest.test.ts`, which counts with `totalChanges`).
- Unit tests for pure logic (status rules, matching), like `test/wondrous-tails.test.ts`.

## 5. Before opening the PR

```bash
cd web
npm test && npm run typecheck && npm run build
npm run lint          # Biome: formatting + lint
npm run test:e2e      # browser smoke tests (Playwright; needs `npx playwright install chromium` once)
```
The plugin builds and its tests run in CI (`dotnet test --solution plugin/FcHub.slnx`). Add a test plan under `docs/test-plans/` for anything that has to be checked in game, and bump the plugin `<Version>` if the plugin changed (see `RELEASING.md`).
