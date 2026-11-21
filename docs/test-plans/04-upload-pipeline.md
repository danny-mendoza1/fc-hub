# Test plan 04 — Upload pipeline and cost guards (plugin v0.3.1, website cost guards)

**Goal:** confirm uploads still work end to end, automatic uploads are spaced out, manual uploads go straight away, and the server's limits are shown clearly in game.

## Setup
1. Website: merge the cost-guards PR, then in `web/`: `npm run db:migrate:remote` (migration 0003) **before** `npm run deploy`.
2. Plugin: merge this PR, then `git tag v0.3.1.0 && git push origin v0.3.1.0`. Update in `/xlplugins`.
3. Have the admin token handy for checks 6–7 (`$ADMIN_TOKEN`, `$URL` = your workers.dev URL).

## Checks

| # | Question | How | Expected |
|---|---|---|---|
| 1 | Do uploads still work? | `/fchub` → **Upload now** | Status "Uploaded." and the website shows fresh data |
| 2 | Are automatic uploads spaced out? | Move items around for 2–3 minutes (craft, gather, sort) | Status updates at most about once a minute; the website catches up within ~2 min |
| 3 | Does a manual upload skip the wait? | Right after an automatic upload, change something and click **Upload now** | Uploads straight away |
| 4 | Does Wondrous Tails still upload? | `/fchub upload`, or **Read journal now** after placing a sticker | WT status "Uploaded."; the website shows the sticker |
| 5 | Does a bad key pause everything? | Settings: put a wrong key, Save | Both inventory and WT show "paused… check your API key". Fix the key and Save: both resume |
| 6 | Is the daily budget enforced and explained? | `curl -X PUT $URL/api/v1/admin/members/<your id>/write-budget -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"dailyWriteRows":1}'`, then **Upload now** after changing an item | Status: "HTTP 429: Your daily upload budget is used up… Next try at <time>". No retries until then (check `/xllog`) |
| 7 | Does lifting it work without a deploy? | Same command with `{"dailyWriteRows":null}`, then **Upload now** | "Uploaded." |
| 8 | Is usage visible? | `curl $URL/api/v1/admin/usage -H "Authorization: Bearer $ADMIN_TOKEN"` | Your `rowsWritten` and `requests` for today; budgets 300000 / 1000000 |

## Results
_Not run yet._
