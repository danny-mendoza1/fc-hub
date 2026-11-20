# ADR 0001 — Collector plugin via Allagan Tools IPC, portable web backend

- **Status:** Accepted (Phase 1)
- **Date:** 2026-11-20

## Context

We want FC members to search each other's inventories (bags, saddlebags, armoury, retainers, FC chest, armoire, dresser).

- No official Square Enix API exposes inventories. Data has to come from the running game client.
- The client only receives a container's contents from the server after the player opens it (retainers, saddlebags, FC chest, armoire). Any approach inherits this.
- **Allagan Tools** (InventoryTools + CriticalCommonLib, GPL-3.0) already scans every container about every 500 ms and persists the results across sessions. It exposes public IPC for other plugins: `AllaganTools.GetCharacterItems`, `GetCharactersOwnedByActive`, `CurrentCharacter`, `IsInitialized`, plus `ItemAdded` / `ItemRemoved` / `RetainerChanged` events.
- All members play on PC through XIVLauncher and are willing to install Allagan Tools.
- Future phases (Wondrous Tails, duty unlocks, quests) need game data that Allagan Tools does *not* expose. We'll need our own plugin eventually regardless.

## Options considered

| | Approach | Verdict |
|---|---|---|
| A | Own plugin that reads inventory through **Allagan Tools IPC** and uploads | **Chosen.** Small, no memory signatures to maintain, no GPL code copied, and gives us a plugin to extend later |
| B | Desktop uploader that reads Allagan Tools' `inventories.csv` | Rejected: depends on an internal file format, and it's another executable to trust and run |
| C | Own plugin that copies the CriticalCommonLib scanner | Rejected for now: ~2k lines plus patch-sensitive hooks, and must become GPL-3.0. Fallback if the IPC proves insufficient |
| D | Lodestone scraping / packet capture (Teamcraft-style) | Rejected: incomplete (retainers only) or a heavier, separate ecosystem |

## Decision

1. **Plugin = thin collector.** FC Hub calls Allagan Tools IPC, builds a JSON snapshot per logged-in character (owner = character, retainer, FC chest, house), and uploads it in the background.
2. **Web app = source of truth + UI.** Phase 1 hosting is **Cloudflare Workers + D1** (fastest stand-up, the owner already uses Cloudflare). The code uses runtime-portable pieces (**Hono** for HTTP, **Drizzle** for SQL over D1 *or* SQLite) so it can run in **Docker** on a homelab later, behind Cloudflare Tunnel + Access (zero trust).
3. **Snapshots, not diffs.** Each upload replaces a character's data. The payload is small, and replacing is idempotent and easy to reason about.
4. **IDs as strings in JSON.** Content IDs are 64-bit and exceed JavaScript's safe integer range.

## Consequences

- Hard runtime dependency on Allagan Tools. FC Hub must detect its absence and degrade gracefully.
- If Allagan Tools changes its IPC contract, FC Hub breaks. The IPC surface we use is small and documented in `plugin/FcHub/Allagan/AllaganToolsIpc.cs`.
- Data freshness for retainers and the FC chest depends on members opening them in-game. The UI must show a "last updated" time per character and owner.
- Distribution happens through a custom Dalamud plugin repository (a `pluginmaster.json` on GitHub), not the official repo.
