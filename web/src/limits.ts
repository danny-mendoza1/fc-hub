/**
 * Cost guards: every limit that bounds what FC Hub can spend, in one place (ADR 0005).
 *
 * D1 bills rows written (and Cloudflare's spending limit doesn't cover D1), so the daily write
 * budget is the main stop: a soft limit that concurrent requests can overshoot by about one upload
 * each (ADR 0005). The upload limits keep any single request small. Defaults live here.
 * Each one can be overridden site-wide without a code change: a Worker variable in wrangler.toml
 * `[vars]` (or an environment variable on Node), named in ENV_NAMES. A member's daily budget can
 * also be raised or lowered at runtime through the admin API, with an expiry (see web/README.md).
 */
export interface Limits {
  /** D1 rows written per member per UTC day, by uploads. Admin overrides replace it per member. */
  memberDailyWriteRows: number;
  /** D1 rows written per UTC day by everyone together: the stop for the whole bill (soft; see ADR 0005). */
  siteDailyWriteRows: number;
  /** false = read-only mode: every upload is refused (emergency switch). */
  writesEnabled: boolean;
  /** Request body cap, after gzip decompression. A full real snapshot is ~250 KB. */
  maxBodyBytes: number;
  ownersPerUpload: number;
  sectionsPerOwner: number;
  /** The largest real sections (glamour dresser, armoire) hold under 1,000 items. */
  itemsPerSection: number;
  itemsPerUpload: number;
  /**
   * Owners (character, retainers, FC chest, houses...) one character may create. A character has
   * 1 + 10 retainers + FC chest + a few houses; the rest is room for dismissed retainers.
   */
  ownersPerCharacter: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  // 1M/day site-wide caps the month at ~30M rows written, under the 50M Workers Paid includes.
  memberDailyWriteRows: 300_000,
  siteDailyWriteRows: 1_000_000,
  writesEnabled: true,
  maxBodyBytes: 4 * 1024 * 1024,
  ownersPerUpload: 24,
  sectionsPerOwner: 32,
  itemsPerSection: 2_000,
  itemsPerUpload: 10_000,
  ownersPerCharacter: 24,
});

/** Variable names for site-wide overrides (wrangler.toml [vars], or env vars on Node). */
export const ENV_NAMES: Readonly<Record<keyof Limits, string>> = Object.freeze({
  memberDailyWriteRows: "LIMIT_MEMBER_DAILY_WRITE_ROWS",
  siteDailyWriteRows: "LIMIT_SITE_DAILY_WRITE_ROWS",
  writesEnabled: "WRITES_ENABLED",
  maxBodyBytes: "LIMIT_MAX_BODY_BYTES",
  ownersPerUpload: "LIMIT_OWNERS_PER_UPLOAD",
  sectionsPerOwner: "LIMIT_SECTIONS_PER_OWNER",
  itemsPerSection: "LIMIT_ITEMS_PER_SECTION",
  itemsPerUpload: "LIMIT_ITEMS_PER_UPLOAD",
  ownersPerCharacter: "LIMIT_OWNERS_PER_CHARACTER",
});

/**
 * Defaults with any overrides applied. An override that isn't a positive whole number is ignored
 * (with a warning) rather than taken as 0 or "unlimited", so a typo can't switch a guard off.
 */
export function resolveLimits(vars: object): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(ENV_NAMES) as (keyof Limits)[]) {
    const raw = (vars as Record<string, unknown>)[ENV_NAMES[key]];
    if (raw === undefined || raw === null || raw === "") continue;
    if (key === "writesEnabled") {
      limits.writesEnabled = !(raw === false || String(raw).trim().toLowerCase() === "false" || String(raw).trim() === "0");
      continue;
    }
    const value = typeof raw === "number" ? raw : Number(String(raw).replaceAll("_", "").trim());
    if (Number.isSafeInteger(value) && value > 0) limits[key] = value;
    else console.warn(`Ignoring ${ENV_NAMES[key]}=${String(raw)}: must be a positive whole number`);
  }
  return limits;
}
