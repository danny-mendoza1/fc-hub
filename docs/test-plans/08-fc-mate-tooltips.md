# Test plan 08 — FC mates in item tooltips (plugin v0.5.0)

**Goal:** confirm the item tooltip lists the other members' items correctly, and that nothing else changed. [Test plan 07](07-tooltip-probe.md) already proved the tooltip mechanism; this checks the real data.

## Setup
1. Merge the PR, then in `web/`: `npm run deploy`. There's no migration; the server only gains `GET /api/v1/items/fc-holdings`.
2. Release the plugin: `git tag v0.5.0.0 && git push origin v0.5.0.0`. Players update in `/xlplugins`.
3. At least **two members** have uploaded recently, with uploads on. In game: `/fchub` shows **Tooltips: N items from M mates**.

## Checks

| # | Question | How | Record |
|---|---|---|---|
| 1 | Does the download happen? | Log in, wait ~20 s, `/fchub` | "Tooltips: … items from 2 mates", "updated 0 min ago" |
| 2 | Do a mate's items show? | Hover an item a mate holds (check the website's search for one) | An "FC mates: N" block in colour 500, above Allagan Tools' block; one line per character and place, e.g. "Mrs Rambo · Retainer Bob · 40" |
| 3 | Are my own items and the FC chest left out? | Hover an item only you or the FC chest hold | No FC mates block (Allagan Tools still shows yours) |
| 4 | NQ and HQ together? | Hover an item a mate has in both qualities | Both lines, the HQ one marked with the HQ glyph |
| 5 | Crystals? | Hover a shard a mate holds | Their crystal count shows |
| 6 | Crafting Log? | `/craftinglog`: hover ingredients a mate holds | Lines show there too |
| 7 | Long lists cap? | Hover something many places hold (e.g. a common material) | At most 10 place lines, then "N more places" |
| 8 | Old data flagged? | Hover an item in a retainer nobody has opened for over a day | " · 3d" style suffix on that line |
| 9 | Refresh? | A mate moves an item and uploads; you run `/fchub upload` | The tooltip changes within a few seconds |
| 10 | Setting off? | `/fchub config` → untick "Show FC mates' items in item tooltips" → Save | Block gone; `/fchub` says "Tooltips: Off" |
| 11 | Uploads off? | Untick uploads → Save, `/fchub upload` | "Tooltips: Off while uploads are off…"; tick it back afterwards |
| 12 | Collectables? (not covered in plan 07) | Hover a collectable a mate holds | Counted with the normal item, no errors |

Also check `/xllog` for `[FcHub]` errors.
