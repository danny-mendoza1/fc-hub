# Plan: FC mates' items in the in-game item tooltip

- **Status:** Built on `feat/plugin-fc-tooltips`: the in-game probe is in [test plan 07](../test-plans/07-tooltip-probe.md), the design record is [ADR 0009](../adr/0009-plugin-reads-fc-holdings.md), and the release checks are [test plan 08](../test-plans/08-fc-mate-tooltips.md).
- **Branch:** `feat/plugin-fc-tooltips`
- **Date:** 2026-11-23

## The problem

Allagan Tools adds an "Owned / Locations" block to every item tooltip, but only for the characters on *your* PC. When Zeke looks up a recipe and hovers an ingredient, he sees whether **he** has it. He can't see that a mate has 40 of them on a retainer without opening the website.

FC Hub already has everyone's inventories on the server. The goal is to add a second block to the same tooltip: which **other members** hold the item, and where.

```
Owned: 3                                   ← Allagan Tools (unchanged)
Locations:
      Zeke Rambo - Saddlebag - 3
FC mates: 52                               ← FC Hub (new)
      Mrs Rambo · Retainer Bob · 40
      Mrs Rambo · Inventory · 2
      Pal Friend · Crystals · 10
```

### Decisions already made

| Question | Answer |
|---|---|
| Whose data | **Other members only.** Your own characters and the FC chest / house are left out, because Allagan Tools already shows them. |
| Which sections | **Storage plus crystals.** These are the "Items in common" sections (bags, saddlebags, armoury, retainer bags, FC chest, storerooms) plus `Crystals`. FC chest and storerooms drop out anyway, because shared storage is excluded. |
| Line detail | **One line per member per place**, like Allagan Tools' style, with a line cap and an "N more places" line. |

## How Allagan Tools does it

The hook lives in CriticalCommonLib (`Services/TooltipService.cs`, pinned commit `420f688`). The lines are written in `InventoryTools/Tooltips/AmountOwnedTooltip.cs`.

1. **One hook on the tooltip builder.** `TooltipService` hooks `AddonItemDetail.GenerateItemTooltip(addon, NumberArrayData*, StringArrayData*)` through `IGameInteropProvider.HookFromAddress`, using FFXIVClientStructs' member function pointer. Before it calls the original, it runs every registered `TooltipTweak` against the **string array**, which holds the tooltip's text fields. It also hooks `AgentItemDetail.OnItemHovered` to capture the hovered `InventoryItem`, but the owned-amount tooltip doesn't use that.
2. **The hovered item comes from `IGameGui.HoveredItem`.** Ids of 2,000,000 or more are event items and are skipped. Otherwise `id % 500000` is the base item id: HQ adds 1,000,000 and collectables add 500,000.
3. **It picks a text field to append to.** It uses `ItemDescription` (string index 13). If that is hidden, it falls back to `Effects` (16) and then `Levels` (23). Visibility is a bit-flag in number array 30, `IntArray[5]`.
4. **It appends SeString payloads.** It reads the field (`MemoryHelper.ReadSeStringNullTerminated`), adds a `UIForegroundPayload(colour)` + `UIGlowPayload(0)` + `TextPayload("\nOwned: …\nLocations:\n      …")` and resets the colour. Then it writes the field back with `StringArrayData.SetValue(index, bytes, …)`.
5. **It guards against appending twice.** First it appends an invisible `DalamudLinkPayload` carrying its own id. If that payload is already in the string, it returns. This matters because the tooltip can be regenerated without a new hover.
6. **The data is local.** It filters `IInventoryMonitor.AllItems` by item id (optionally only the active character). It groups by owner/category/flags, marks HQ with `` and collectables with ``, and caps the lines (`TooltipLocationLimit`), adding "N other locations."

**Licence note:** Allagan Tools and CriticalCommonLib are GPL-3.0, and [ADR 0001](../adr/0001-architecture.md) commits FC Hub to copying no GPL code. We take the *technique*: edit the ItemDetail string array before the game lays it out. The code is written fresh against Dalamud and FFXIVClientStructs APIs.

## Design

### Data flow

```
 Mate's PC ──upload (existing)──► server ◄──GET /api/v1/items/fc-holdings (new, every 5 min)── Zeke's plugin
                                                                                  │ in-memory index
                                         hover item ──► ItemDetail tooltip ◄──────┘ (no network on hover)
```

The plugin downloads every other member's holdings in one request every few minutes and keeps them in memory. A hover is a dictionary lookup, so it never touches the network. This is the first time the plugin **reads** from the server, so it gets an ADR (see Docs).

### Server (`web/`)

All of this extends what "Items in common" already does. The only new function is a three-line store query.

| Change | Where | Reuse / refactor |
|---|---|---|
| `TOOLTIP_SECTIONS = [...STORAGE_SECTIONS, "Crystals"]` | `src/item-overlap.ts` | Next to `STORAGE_SECTIONS`, with a comment on why crystals count here and not for "in common" |
| `placesQuery(filter)` becomes `placesQuery(sections, filter)` | `src/item-overlap-store.ts` | **Refactor:** the section list is the only difference. `STORAGE_SQL` becomes a small `sqlList(sections)` helper. `alsoIn` and `itemsInCommon` pass `STORAGE_SECTIONS`. |
| `fcHoldings(db, memberId)` | `src/item-overlap-store.ts` | `compactPlaces(group(rows))` over `placesQuery(TOOLTIP_SECTIONS, "AND m.id != ?1 AND o.kind NOT IN ('freeCompany','housing')")`. Same `group` and `compactPlaces` as `alsoIn`. It still reads only active members' data through `FROM_ACTIVE_ITEMS`. |
| `GET /api/v1/items/fc-holdings` | `src/app.ts` | `{ access: "member", writes: "none" }`: bearer key only (the plugin is the only caller) and a read-only database |
| `FcHoldingsWire = PlacesWire` | `src/item-overlap.ts`, re-exported in `src/api-types.ts` | The existing compact wire format: each section's owner, member and character are sent once, and places are `[section, quantity, stacks]` |

There's no migration and no new index. The query is the "in common" query with one extra filter.

**Cost:** each fetch reads roughly the other members' item rows, say 10k. Fetching every 5 minutes, for 3 members, all day, comes to about 260M rows read a month, against 25 billion included. It writes no rows. The `cost-guards` and `visibility` tests cover the new GET route automatically.

**Size:** each item also carries `name`/`iconId`, which the plugin ignores. That's the price of reusing `PlacedItem` unchanged. Compressed, it should be tens of KB; we measure it against real data when the route is built. The HTTP client will ask for compressed responses (next section).

### Plugin (`plugin/FcHub/`)

| Change | Where | Reuse / refactor |
|---|---|---|
| `GetFcHoldingsAsync(server, apiKey, ct)` | `Upload/HubClient.cs` | Same shape as `GetMeAsync`, using the existing private `SendAsync<T>` |
| Compressed responses | `Upload/HubClient.cs` constructor | `new HttpClient(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All })`. One line, and every call benefits |
| Wire records `FcHoldingsWire`, `PlaceSectionWire`, `PlacedItemWire` (`int[]` places) | `Upload/FcHoldingsModels.cs` | Mirrors the TS `PlacesWire`, deserialized with `UploadJson.Options` like the other responses |
| `FcHoldings`: an index built from the wire, plus the tooltip text | `Tooltips/FcHoldings.cs` | **Pure** (no Dalamud), so it's unit-tested. Builds `itemId → lines` for NQ and HQ together, like Allagan Tools. Place labels reuse `Locations.CategoryLabel(Enum.Parse<AllaganCategory>(section))`, with "Retainer «name»" for retainers. Sorted by member, then quantity descending. Cap of **10 lines** plus "N more places": 12 fit in the probe, which leaves room for Allagan Tools' block. HQ is marked with the game's HQ glyph (``). |
| `FcHoldingsSync`: fetch on a timer | `FcHoldingsSync.cs` (next to `SyncService` and `WondrousTailsSync`) | Follows `WondrousTailsSync`'s framework-tick timer: 15 s after login, then every 5 min, plus `/fchub upload`. **Sends through the shared `UploadChannel`**, so it gets backoff, the 401 pause and `Retry-After` for free, as `docs/extending.md` requires. Exposes `Holdings` and a status line. |
| `ItemTooltip`: write the lines into the tooltip | `Tooltips/ItemTooltip.cs` | The only game-facing code. It registers an `IAddonLifecycle` listener on `"ItemDetail"`, normalises `IGameGui.HoveredItem`, picks the visible field, appends once and writes the field back. **Already built and proven in Phase 0.** The "already present" check is required, because the tooltip regenerates constantly. Colour is UIColor **500**. The string array is found by name on the first hover (index 27 today) rather than hard-coded, so a patch that renumbers the arrays doesn't break it. |
| Setting `ShowFcMatesInTooltips` (default on) | `Configuration.cs`, `Windows/ConfigWindow.cs` | One checkbox under the upload toggle |
| Status line | `Windows/MainWindow.cs` | "Tooltips: 3 mates, 1,204 items, updated 2 min ago", next to the existing upload status |
| Wiring | `Plugin.cs` | Construct `FcHoldingsSync` (shared `HubClient` + `UploadChannel`) and `ItemTooltip`, add the sync to `/fchub upload`, and dispose both |

**Sharing goes both ways:** reusing `UploadChannel` as is means tooltips need **uploads on**. `Blocked()` checks `UploadEnabled` first. That needs no refactor, and you only see mates if you share yours. If you'd rather allow read-only members, the change is to move the `UploadEnabled` check out of `UploadChannel.Blocked` into its two upload callers. See open question 1.

**Retry when the channel is busy:** `WondrousTailsSync` already retries in 5 s when the channel is busy, and `FcHoldingsSync` does the same. *As built:* the retry is three lines of each sync's own timer state, so lifting it into `UploadChannel` would have meant callbacks for less code than it saved. What's shared instead is `UploadChannel.BusyRetryDelay`, which both syncs use.

**Threading:** the `UploadChannel` callback runs on the framework thread, and so do addon lifecycle events. `Holdings` is replaced by swapping a reference, so no locks are needed.

### Tests

| Test | Where |
|---|---|
| Route: excludes the caller's own member, excludes FC chest and house, includes crystals, leaves out equipped/market/glamour | `web/test/item-overlap.test.ts` (next to the "in common" tests) |
| **Read contract fixture:** the server's response for seeded data equals the fixture byte for byte, and the plugin deserializes it and builds the expected lines | `web/test/fixtures/fc-holdings-v1.json`, `web/test/plugin-contract.test.ts`, `plugin/FcHub.Tests/ContractTests.cs` |
| `FcHoldings`: NQ and HQ under one item id, label per section, retainer names, sort order, cap plus "N more places", unknown item gives no lines | `plugin/FcHub.Tests/FcHoldingsTests.cs` |
| Covered automatically | `cost-guards.test.ts` (the GET writes nothing) and `visibility.test.ts` (a revoked member disappears). *As built:* `visibility.test.ts` only walked `memberOrCookie` routes, so it now also checks bearer-only (`member`) GET routes; otherwise it wouldn't have covered this one. |

### Docs and release

- `docs/adr/0009-plugin-reads-fc-holdings.md`: the plugin now downloads data. It covers why polling rather than a fetch per hover, the read cost, and why shared storage is excluded.
- `docs/test-plans/08-fc-mate-tooltips.md`: the release checks for the finished feature (the Phase 0 probe is test plan 07).
- `docs/extending.md`: a short "Reading data back in the plugin" row that points at this feature as the example.
- README roadmap, plugin `<Description>`, and `<Version>` 0.4.0 → **0.5.0**.
- Deploy order: server first (a new route, nothing else changes), then tag the plugin.

## Phase 0 results (in-game probe, 2026-11-23)

Everything we needed to know is settled; details are in [test plan 07](../test-plans/07-tooltip-probe.md).

- **Mechanism:** Dalamud's `PreRequestedUpdate` on `ItemDetail` works everywhere we tried: bags, the Crafting Log, the Recipe Tree, the market board and chat links. **No hook is needed.**
- **Allagan Tools:** both blocks show, with FC Hub's on top. Neither breaks the other.
- **Fields:** the description → effects → levels fallback was needed and worked (meals use effects; some gear uses levels).
- **Duplicates:** the tooltip regenerated 212 times out of 448 updates. The "already present" check kept our lines single every time, so it stays.
- **Size:** 12 lines fit, and the tooltip grows and repositions itself. The cap is set to 10 to leave room for AT.
- **Colour:** UIColor 500.
- **Not covered:** hovering a collectable. They're decoded (unit-tested) and counted with NQ (see Out of scope). We'll check it during test plan 08.

The probe class (`Tooltips/ItemTooltipProbe.cs`) and the `/fchub tooltipprobe` command were removed once the real text provider (`FcHoldingsSync.TooltipText`) replaced them.

## Open questions (defaults in bold)

1. Should a member with **uploads off** still see mates' items? **No: sharing goes both ways, so no refactor.** Yes means moving the `UploadEnabled` check out of `UploadChannel.Blocked`.
2. Show how old the data is? **Add "· 3d" when a section is older than 24 h**, since a retainer's data can be weeks old (ADR 0001).
3. Should the line name the character or the member's display name? **The character name** ("Mrs Rambo"), because that's what's visible in game. A member's alts appear under their own names.
4. Refresh interval: **every 5 min**, plus on login and on `/fchub upload`.
5. Should holdings be cached on disk so they show the moment you log in, before the first fetch? **No**, because the first fetch lands about 15 s after login.

## Out of scope

- Collectable-specific matching (collectables count with NQ).
- Per-member filters or a "hide this mate" setting.
- Showing amounts in the Crafting Log's own ingredient columns (the "how many I have" numbers). That's a different addon.
