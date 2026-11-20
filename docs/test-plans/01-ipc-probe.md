# Test plan 01 — Allagan Tools IPC probe

**Goal:** confirm FC Hub can read everything we need from Allagan Tools before we build the web side.

## Setup
1. `cd plugin && dotnet build` (needs the .NET 10 SDK).
2. In game, `/xlsettings` → Experimental → Dev Plugin Locations → add the full path to `plugin\FcHub\bin\x64\Debug\FcHub.dll` → Save.
3. `/xlplugins` → Dev Tools → Installed Dev Plugins → enable **FC Hub**.
4. `/fchub` opens the probe window.

## Checks

| # | Question | How | Record |
|---|---|---|---|
| 1 | Does the plugin load and detect Allagan Tools? | Window status dots | Both "Allagan Tools loaded" and "IPC ready" green? |
| 2 | Are retainers / FC chest from *earlier sessions* returned without visiting them? | Fresh login, don't touch the bell, press Refresh | Owners listed, kinds, item counts |
| 3 | Are retainer names known? | Before and after opening a summoning bell | Names column before/after |
| 4 | Are locations correct? | Hover a row's "Locations seen", pick 2–3 items, compare with in-game positions (bag/page/slot) | Matches? Off by one? Per-page or overall slot numbers? |
| 5 | Do change events fire? | Move or discard an item, buy something | IPC event counters increase, "auto rebuilds" goes up about 5 s later |
| 6 | Is it cheap? | Read the build / IPC / serialize timings and payload size | ms values, KB |
| 7 | Any hitching? | Play normally for a few minutes with the plugin enabled | Any stutter when auto rebuilds happen? |
| 8 | What does the payload look like? | Click **Write snapshot file** (or `/fchub dump`) and share the JSON | File path, attach or paste a sample |

Also check `/xllog` for `[FcHub]` errors.

## Results — run 1 (2026-11-20, Brother Deez @ Kraken)

| # | Result |
|---|---|
| 1 | ✅ Allagan Tools loaded + IPC ready. Retainer list not in memory (0) until a bell is used. |
| 2 | ⚠️ Fresh session: only the character (334 items) and the FC chest showing **1 item** (FC credits). Retainers absent until a retainer was opened; FC chest pages absent until the chest was opened. **Open: does Allagan Tools return them after a relog (persisted data)? See run 2.** |
| 3 | ✅ Opening one retainer loaded all 3 names (dot green, "3 in memory"). Each retainer's items appeared automatically within ~2–5 s of opening it. An extra owner `86131342900265472` (hex `0x0132000001990200`, looks like a housing id) shows as Unknown with 0 items. |
| 4 | ✅ Locations correct (per-page slot numbers). FC chest correct after opening it (221 items). |
| 5 | ✅ Add/remove updates within ~5 s. ⚠️ **Moving an item within the same container doesn't fire an IPC event**, so auto-rebuild misses reorders until a manual Refresh. |
| 6 | ✅ No hitching. Payload 365 KB pretty-printed → 219 KB compact → **21 KB gzipped** (915 items). |
| 7 | ✅ Snapshot captured. Item 80 (FC credits, container 2502) has an empty name in the Item sheet. |
| 8 | ✅ No FcHub errors. Dalamud validation: "does not register a config UI callback". |

### Follow-ups
- Server should merge **per owner and section**, keeping the last-known data (with its own timestamp) when a section isn't loaded in this session. Don't wipe a retainer just because this session hasn't opened it.
- Rebuild periodically (cheap) and upload only when a content hash changes, so reorders are caught.
- Skip owners with no items. Special-case item 80 as "FC credits".
- Add a settings window (server URL + API key), which also satisfies the validation warning.
