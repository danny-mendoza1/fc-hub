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
