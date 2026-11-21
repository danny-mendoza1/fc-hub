-- When a section's contents were last seen in game (ADR 0008), as opposed to captured_at, when they
-- were last reported. Set only for shared sections (FC chest, houses) that the reporting plugin saw
-- change in front of it; NULL means "reported from Allagan Tools' cache, age unknown". A sighting
-- outranks any report, so a stale cache can't replace a mate's newer look (web/src/ingest.ts).
-- Safe to apply before deploying the code that uses it: the old code ignores the column, and NULL
-- everywhere keeps today's last-report-wins order until sightings arrive.
ALTER TABLE owner_sections ADD COLUMN observed_at TEXT;
