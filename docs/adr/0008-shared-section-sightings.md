# ADR 0008: Shared sections rank sightings above reports

- **Status:** Accepted.
- **Date:** 2026-11-21

## Context

Several members report the same FC chest and FC house. The server kept whichever report had the latest `capturedAt`, the time the plugin built its snapshot.

That time says nothing about how old the contents are. Allagan Tools keeps every container's contents between sessions and returns them as current. FC Hub normally re-sends a section only when it changes, so a stale cache usually stays home. But several ordinary paths send it anyway, stamped "now":

- A fresh install, which includes every new member.
- **Re-upload everything**. Its tooltip suggests it when the website looks out of date.
- An alt in the same FC. Upload hashes are tracked per character, but Allagan Tools' FC data is shared.
- A retry after a 429 or a network error. The snapshot is rebuilt with a new time.

Each of these could replace a mate's more recent look. It then stayed wrong, because the mate's plugin had nothing new to send. This was finding 4 of an external review; finding 1, the same kind of overwrite through a race, is fixed in ADR 0004's amendment.

## Decision

1. **The plugin records sightings.** Allagan Tools only learns an FC chest's or storeroom's contents when the game sends them, which happens when it's open. So a shared section whose contents *change between two snapshots* while FC Hub runs was seen then. `ObservationTracker` stores, per owner and section, the time and a hash of what was seen. The key is per owner, not per character, because alts share the data. The store lives in the plugin config, so it survives restarts.
2. **Shared sections carry `observedAt`** in the upload (an optional field within schema v2). It's set only when the section's contents still match its last sighting. The first sight in a session, or contents that changed while FC Hub wasn't watching, send `null`.
3. **The server ranks freshness** (`replaces` in `web/src/ingest.ts`, and the same rule as the section upsert's `WHERE`):
   - A sighting beats any report.
   - Between two sightings, the newer one wins.
   - Between two reports, the later `capturedAt` wins, as before.
   - `observedAt` is clamped to the upload's `capturedAt`.
4. `owner_sections.observed_at` stores it (migration `0005_observed_at.sql`). The owner panel on the website shows "seen in game" for sections that have it.

Alternatives considered:
- **An observation time from Allagan Tools.** The IPC that FC Hub uses (`GetCharacterItems` and the change events) carries no timestamps.
- **Detecting the FC chest window opening (addon lifecycle).** That would catch a look at an unchanged chest, but it means hooks for each container type, and a look that changes nothing matters little: the stored data is already right.
- **Letting reports age out** (for example, a report older than N days loses to anything). That's arbitrary, and it still lets a stale cache win against an old but correct sighting.

## Consequences

- A stale cache can no longer replace a sighting, whatever path sends it or how uploads interleave. Tests: `web/test/observed-at.test.ts` and `web/test/ingest-concurrency.test.ts`; `plugin/FcHub.Tests/ObservationTrackerTests.cs`.
- **A report never replaces a sighting**, even a much older one. If a member's cache is actually fresher (they changed the chest without the plugin running), the website keeps the sighting until someone changes the chest while FC Hub runs. For one FC that's acceptable, and the website now shows which kind of time it's displaying.
- Existing rows have `observed_at = NULL`, so the first sighting of each shared section replaces them. Older plugins keep the old last-report-wins behaviour among themselves.
- **What counts as a sighting is inferred.** If Allagan Tools ever rewrites a cached container without the game sending it, that rewrite is taken for a sighting. Test plan 05 checks this in game.
- Deploy order: `npm run db:migrate:remote` (0005), then `npm run deploy`, then the plugin release (0.4.0.0). The old server ignores `observedAt`, and the old code ignores the column, so a partial rollout is safe.
