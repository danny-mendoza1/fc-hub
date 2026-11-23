# Test plan 07 — Item tooltip probe (Phase 0, not released)

> The probe (`/fchub tooltipprobe`) was removed after this run; the finished feature is checked by [test plan 08](08-fc-mate-tooltips.md).

**Goal:** before building "FC mates in tooltips" ([plan](../plans/fc-mate-tooltips.md)), find out in game how the item tooltip behaves when FC Hub adds lines to it. The probe adds fixed test lines and logs each step; it changes nothing else and uploads nothing.

## Setup
1. Build this branch: `cd plugin && dotnet build`. The DLL is `plugin/FcHub/bin/x64/Debug/FcHub.dll` **in this worktree** (`.claude/worktrees/feat-plugin-fc-tooltips`).
2. `/xlsettings` → **Experimental** → **Dev Plugin Locations**: point FC Hub at that DLL instead of the main checkout's (only one FC Hub can be loaded). `/xlplugins` → reload FC Hub.
3. Open `/xllog` and filter on `Tooltip probe`.
4. `/fchub tooltipprobe` turns it on (3 lines, the tooltip's own colour). `/fchub tooltipprobe 8 500` = 8 lines in UIColor 500. `/fchub tooltipprobe off` turns it off.

## Checks

| # | Question | How | Record |
|---|---|---|---|
| P1 | Does the lifecycle event reach the tooltip, and which string array is it? | Probe on, hover any item in your bags | Probe lines in the tooltip? Log: "Found ItemDetail's string array at index N" (write N down) and "appended to the description field" |
| P2 | Does it work in the Crafting Log? | `/craftinglog`, hover the result item, each ingredient, and an ingredient in **Recipe Tree** (right-click → Recipe Tree) | Lines shown in each? |
| P3 | Does a regenerated tooltip duplicate our lines? | Hover an item, then hold/release Shift and Ctrl, move between two stacks of the same item, and hover a stack while it changes (e.g. buy one from a vendor) | Lines appear once? Log shows "already in the … field" lines? |
| P4 | Does it get along with Allagan Tools? | Hover an item you own, with AT's tooltip on, then off (AT settings → Tooltips) | Both blocks shown? Which comes first? Anything broken or missing? |
| P5 | Which field is used for items without a description? | Hover a crystal, a piece of gear, a meal/potion, a materia | Log says description / effects / levels, or "no visible text field"? Lines shown? |
| P6 | How many lines fit? | `/fchub tooltipprobe 5`, then `8`, then `12`, hovering an item near the bottom of the screen | Largest count that still fits comfortably at your UI scale |
| P7 | What do other windows report? | Hover items on the market board, a chat item link, the retainer sell list, an HQ item and a collectable; try a gamepad if you use one | Log: hovered id and "HQ True/False, collectable True/False"; lines shown? |
| P8 | Which colour reads well next to AT's block? | `/fchub tooltipprobe 3 0`, then `3 500`, `3 45`, `3 37` (any UIColor ids) | Preferred colour id |

Also: anything odd (flicker, a tooltip that doesn't resize, `/xllog` errors from `[FcHub]`).

## Results (2026-11-23, plugin 0.4.0 + probe, Allagan Tools 15.1.1)

From play and `dalamud.log`: 448 tooltip updates, 236 appends, 212 skipped as already present, no errors.

| # | Result |
|---|---|
| P1 | **Pass.** The lifecycle event works, so no hook is needed. ItemDetail's string array is **index 27** (size 65), found on the first hover. Number array 30 gave the field visibility on every hover. |
| P2 | **Pass.** It works for Crafting Log results, ingredients and the Recipe Tree. |
| P3 | **Pass, thanks to the guard.** The tooltip regenerates very often (212 of 448 updates already had our text), and the "already present" check kept the lines single every time. **The guard is required.** |
| P4 | **Pass.** Both blocks show, with FC Hub above Allagan Tools. |
| P5 | **Pass.** All three fallbacks were used and shown: description 209, effects 17 (meals and potions), levels 10 (gear without a description). It never hit "no visible text field". |
| P6 | **Pass.** 12 lines fit. The tooltip grows and moves to stay on screen. |
| P7 | **Pass** for the market board, chat links and HQ (HQ was decoded correctly, e.g. item 36070 both NQ and HQ). **Not covered:** no collectable was hovered (0 in the log). |
| P8 | **UIColor 500.** |
