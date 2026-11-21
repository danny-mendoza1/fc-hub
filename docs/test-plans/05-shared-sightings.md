# Test plan 05 — Upload integrity: races, rejected owners, FC chest sightings (plugin v0.4.0, website)

**Goal:** confirm in game what the unit tests can't. The plugin should treat the FC chest as *seen* only when it really was, keep resending owners the server rejected, and stop an old cached FC chest from replacing a mate's newer look.

## Setup
1. Website: merge the PRs, then in `web/`: `npm run db:preflight:remote`, `npm run db:migrate:remote` (migration 0005) **before** `npm run deploy`.
2. Plugin: `git tag v0.4.0.0 && git push origin v0.4.0.0`, then update in `/xlplugins`.
3. Two members (A and B) in the same FC, both on 0.4.0.0. `/xllog` open.

## Checks

| # | Question | How | Expected |
|---|---|---|---|
| 1 | Is logging in *not* a sighting? | A logs in and does nothing with the FC chest; **Upload now** | On the website, the FC chest panel shows a plain time, not "seen in game" (unless A had a sighting from an earlier session that still matches) |
| 2 | Is a change at the chest a sighting? | A opens the FC chest and moves or deposits one item; wait ≤ 60 s | Website: FC chest says "seen in game just now" |
| 3 | Does Allagan Tools rewrite cached data on its own? | A logs out and in, then waits 2–3 minutes **without** opening the chest | No new "seen in game" time (it stays the check 2 time) |
| 4 | Does a stale cache lose? | B opens the chest and changes something (B's sighting). Then A, who hasn't opened the chest since check 2, clicks **Re-upload everything** | A's status: "Uploaded (1 already newer on server)". The website still shows B's contents and B's time |
| 5 | Does a newer sighting win? | A opens the chest and changes something | Website shows A's contents, "seen in game just now" |
| 6 | Do alts behave? | A switches to an alt in the same FC without opening the chest; **Upload now** | The website keeps the newest sighting (check 5) |
| 7 | Are rejected owners retried? | Admin: set `LIMIT_OWNERS_PER_CHARACTER = "1"` in `wrangler.toml` `[vars]` and deploy, then `curl -X DELETE $URL/api/v1/admin/owners/<one of A's retainer ids> -H "Authorization: Bearer $ADMIN_TOKEN"`, so that retainer is new again and over the cap. A clicks **Re-upload everything** | Status keeps "The server rejected 1 owner(s)…" on later checks, and `/xllog` shows no retry every minute. Remove the override, deploy, then **Upload now**: the retainer reappears on the website |

## Results
_Not run yet._
