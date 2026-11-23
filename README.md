# FC Hub

A shared hub for a small FFXIV Free Company. **Phase 1** answers one question:

> *"Does anyone in the FC have this item, and where is it?"*

Each member runs a lightweight Dalamud plugin that collects what their characters, retainers, and FC chest hold. The plugin uploads a snapshot to a small web app, and anyone in the group can search there to see **who** has an item, **how many**, and **exactly where** (e.g. *Retainer "Bob", page 3, slot 12*).

## How it fits together

```
 FFXIV client                          Web (Workers + D1 now, Docker later)
┌──────────────────────────────┐      ┌──────────────────────────────────────────┐
│ Allagan Tools (existing)     │      │  API (TypeScript)  Storage (SQLite/D1)   │
│   scans bags/retainers/FC    │      │   POST /snapshots ───► latest snapshot   │
│        │ IPC                 │ HTTPS│   GET  /search    ◄─── per character     │
│        ▼                     │ ───► │                                          │
│ FC Hub plugin (this repo)    │      │  UI: item search → who / how many / where│
│   builds snapshot, uploads   │      └──────────────────────────────────────────┘
└──────────────────────────────┘
```

- **Collection:** Allagan Tools already reads every inventory container and persists it between sessions. FC Hub reads that data through Allagan Tools' public IPC instead of re-implementing the scanner. See [ADR 0001](docs/adr/0001-architecture.md).
- **Storage + presentation:** a zero-dependency TypeScript web API on Cloudflare (Workers + D1) for the fastest stand-up. The same code runs on Node's built-in SQLite, so it can move to a Docker container on a homelab behind Cloudflare Tunnel/Access later. See [ADR 0002](docs/adr/0002-zero-dependency-backend.md) and [web/README.md](web/README.md).

## Repository layout

| Path | What |
|---|---|
| `plugin/` | Dalamud plugin (C#, .NET 10, Dalamud API 15) |
| `web/` | Web API (TypeScript, Workers + D1 / Node + SQLite) and React UI (`web/client`) |
| `docs/adr/` | Architecture decision records |
| `docs/extending.md` | How to add a feature end to end (plugin → API → website), and the tests that go with it |
| `docs/adr/0006-supply-chain.md` | Dependency pinning, update cooldown and vulnerability checks |

## Roadmap

- **Phase 1 — Shared inventory** *(in progress)*
  - [x] Research how inventory data is gathered
  - [x] IPC probe plugin: prove we can read Allagan Tools data in-game
  - [x] Web API + storage
  - [x] Plugin uploads snapshots (only changed sections, gzip, settings window)
  - [x] Search UI
  - [x] Distribution via a custom Dalamud plugin repository ([install guide](docs/INSTALL.md), [releasing](docs/RELEASING.md))
- **Phase 2 — Wondrous Tails** *(in progress)*
  - [x] Plugin reads and shares one journal per member (alts ignored)
  - [x] Website: each member's book, this week / last week / turned in, duties in common for a chosen party, second chances
  - [ ] Category-to-duty matching (e.g. "Dungeons (Lv. 81–89)" ↔ "The Tower of Zot")
- **In-game tooltips** *(in progress)*: item tooltips show which FC mates hold the item and where, next to Allagan Tools' own block ([plan](docs/plans/fc-mate-tooltips.md), [ADR 0009](docs/adr/0009-plugin-reads-fc-holdings.md))
- **Later ideas:** dungeon/trial/raid unlock comparison, quest prerequisites, homelab hosting with zero-trust access.

## Building the plugin

Prerequisites (Windows): the [.NET 10 SDK](https://dotnet.microsoft.com/download), and XIVLauncher with Dalamud launched at least once, since the build references the Dalamud assemblies in `%AppData%\XIVLauncher\addon\Hooks\dev\`.

```powershell
cd plugin
dotnet build
```

`dotnet test` (here in `plugin/`, or `dotnet test --solution plugin/FcHub.slnx` from the repo root) runs the plugin's unit and contract tests on Microsoft Testing Platform (no game needed); CI runs them on every PR.

The output is `plugin/FcHub/bin/x64/Debug/FcHub.dll`. In game: `/xlsettings` → **Experimental** → add that DLL's full path under **Dev Plugin Locations** → Save. Then `/xlplugins` → **Dev Tools → Installed Dev Plugins** → enable **FC Hub**.

Requires the **Allagan Tools** plugin, installed from the official Dalamud repository.

**Just want to use it?** See [docs/INSTALL.md](docs/INSTALL.md); no building required.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/): `feat(plugin): …`, `fix(web): …`, `docs: …`, `chore: …`. Scopes: `plugin`, `web`, `docs`, `repo`.
- **Branches:** `<type>/<short-description>`, e.g. `feat/plugin-ipc-probe`, `fix/web-search-paging`, `docs/adr-hosting`. Branch from `main` and merge back when the work is verified.
