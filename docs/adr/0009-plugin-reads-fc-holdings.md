# ADR 0009: The plugin reads FC mates' holdings for item tooltips

- **Status:** Accepted.
- **Date:** 2026-11-23

## Context

Allagan Tools adds "Owned / Locations" to every item tooltip, but only for the characters on the player's own PC. An FC member checking a recipe can't see that a mate holds the ingredient without opening the website. FC Hub already has everyone's inventories on the server.

Until now the plugin only uploaded: [ADR 0001](0001-architecture.md) made it a thin collector. Showing mates' items in game means it has to **read** from the server too.

## Decision

1. **One download, then local lookups.** `GET /api/v1/items/fc-holdings` returns every other member's storage in one response. The plugin fetches it about 15 s after login, every 5 minutes, and on `/fchub upload`, and keeps it in memory (`FcHoldingsSync`). A hover reads only that index (`FcHoldings`); a tooltip never waits on the network.
2. **Only what Allagan Tools can't show.** The caller's own characters and the shared FC chest and houses are left out, because Allagan Tools already lists them in the same tooltip. The sections are the "Items in common" storage sections plus crystals, which crafters often need from someone else.
3. **The existing query and wire format.** The route reuses "Items in common": the same `placesQuery` (now given its section list) and the compact `PlacesWire`. Each item still carries its name and icon id, which the plugin ignores. Reusing the shape was worth those bytes.
4. **Bearer key only, read-only.** The policy is `{ access: "member", writes: "none" }`. The plugin is the only caller, so a browser session can't read the route, and the router gives it a database that throws on any write (ADR 0005).
5. **Through the shared `UploadChannel`.** The download gets the same backoff, rejected-key pause and `Retry-After` handling as uploads. Because the channel only sends while uploads are on, **a member sees their mates' items only while sharing their own.**
6. **The tooltip is edited through Dalamud's addon lifecycle, not a hook.** `ItemTooltip` appends to the ItemDetail window's text just before the game draws it (`PreRequestedUpdate`), with a check so a redrawn tooltip isn't appended twice. Allagan Tools does this with a hook in CriticalCommonLib. FC Hub reimplements the idea against Dalamud and FFXIVClientStructs, and copies no GPL code (ADR 0001). Test plan 07 proved the lifecycle approach in game before the rest was built.

Alternatives considered:
- **Fetch on hover.** That's always fresh, but a request per tooltip makes hovering wait on a round trip, and the tooltip redraws hundreds of times a session.
- **Include the caller's own data and the FC chest.** That's simpler, but every line would appear twice next to Allagan Tools' block.
- **A separate read channel that works with uploads off.** That means a second copy of the backoff and key-pause logic for little benefit, since every member is expected to share.

## Consequences

- **Reads, not writes.** Each download reads roughly every other member's storage rows. At an estimated ~10k rows, every 5 minutes, for 3 members, that's ~260M rows a month against 25 billion included. It writes nothing. `cost-guards.test.ts` checks that, and `visibility.test.ts` (now covering bearer-only GET routes too) checks that a revoked member disappears from it.
- **A mate's change shows up within about 5 minutes** of their upload landing. That's also how fresh the website is. Lines older than a day show their age (`· 3d`), because a retainer's contents are only as fresh as the last visit to the bell.
- **A new contract direction.** `web/test/fixtures/plugin-fc-holdings-v1.json` is written by the server's test and parsed by the plugin's test, so a change to the response shape fails one side.
- **The tooltip depends on ItemDetail's arrays.** The string array is found by matching the item name, not hard-coded, so a patch that renumbers the arrays doesn't break it. If the field layout changes, our lines stop showing (nothing crashes), and test plan 08 is the check after a patch.
