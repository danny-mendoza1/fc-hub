# Test plan 02 — Plugin uploads (v0.2.0)

**Goal:** confirm the plugin uploads to the deployed FC Hub, sends only changes, and recovers from errors.

## Setup
1. `git checkout feat/plugin-upload && git pull`, then `cd plugin && dotnet build`. Or download the `FcHub` artifact from the PR's CI run.
2. In game, toggle FC Hub off and on in `/xlplugins` → Dev Tools. The version should read 0.2.0.0.
3. `/fchub config` (or the cog in `/xlplugins`) opens **FC Hub settings**. The Dalamud "no config UI" validation warning should be gone.

## Checks

| # | Question | How | Record |
|---|---|---|---|
| 1 | Does Test connection work? | Enter the workers.dev URL and your key → **Test connection** | "Connected as …"? |
| 2 | Are bad inputs rejected? | Try `http://…workers.dev`, then a key without `fch_` → Save | Error shown, nothing saved |
| 3 | Does the first upload send everything? | Tick "Upload my inventories automatically" → Save | Main window: "Uploads: Uploaded." with ~16 sections / ~1,000 items |
| 4 | Is the data on the server? | `curl "<url>/api/v1/search?q=tincture" -H "authorization: Bearer fch_…"` | Your tinctures with locations |
| 5 | Does it upload only changes? | Wait 60 s without touching anything | Status "Up to date.", no new upload |
| 6 | Are moves caught? | Move an item within one retainer (no IPC event) and wait ≤ 60 s | Upload of **1 section** |
| 7 | Do adds/removes go up quickly? | Move an item character → retainer | Upload ~5 s later, 2 sections |
| 8 | Does a bad key pause uploads? | Change the key to `fch_wrong` → Save | "HTTP 401 … Uploads paused" in red, no retry spam in `/xllog` |
| 9 | Does it recover? | Put the right key back → Save | Uploads resume |
| 10 | Does a different character work? | Log into an alt (if any) | `/api/v1/me` lists both characters |

Also check `/xllog` for `[FcHub]` errors.
