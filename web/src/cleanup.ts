import type { SqlDatabase } from "./db/types.ts";

/**
 * Admin housekeeping (web/README.md, "Housekeeping"). Nothing here runs on its own: an admin calls it, and
 * every action can be previewed with a dry run. Deletes cost D1 writes too, so it's a deliberate,
 * occasional action rather than something on every request.
 */

/** Usage ledger rows older than this are dropped (the admin report only needs recent days). */
export const USAGE_KEEP_DAYS = 90;

/** Characters whose member was revoked. */
const REVOKED_CHARACTERS = `(SELECT c.content_id FROM characters c JOIN members m ON m.id = c.member_id WHERE m.revoked_at IS NOT NULL)`;
const REVOKED_MEMBERS = `(SELECT id FROM members WHERE revoked_at IS NOT NULL)`;

export interface CleanupReport {
  dryRun: boolean;
  /** Revoked members' uploads: their characters, retainers, journals, and the shared sections they reported. */
  revoked: { members: number; characters: number; owners: number; sections: number; items: number; journals: number };
  expiredSessions: number;
  usageRowsOlderThan90Days: number;
}

async function count(db: SqlDatabase, sql: string, ...values: (string | number)[]): Promise<number> {
  return (
    (
      await db
        .prepare(sql)
        .bind(...values)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

/**
 * Removes revoked members' data (it's already hidden everywhere; this frees the storage and lets
 * their characters be claimed again), expired browser sessions, and old usage rows.
 */
export async function cleanup(db: SqlDatabase, now: Date, dryRun: boolean): Promise<CleanupReport> {
  const nowIso = now.toISOString();
  const usageCutoff = new Date(now.getTime() - USAGE_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);

  const report: CleanupReport = {
    dryRun,
    revoked: {
      members: await count(db, `SELECT COUNT(*) AS n FROM ${REVOKED_MEMBERS}`),
      characters: await count(db, `SELECT COUNT(*) AS n FROM ${REVOKED_CHARACTERS}`),
      // Owners left with no section from an active member are removed; shared ones that still
      // have other members' sections are kept and handed to one of those members.
      owners: await count(
        db,
        `SELECT COUNT(*) AS n FROM owners o
         WHERE o.reported_by IN ${REVOKED_CHARACTERS}
           AND NOT EXISTS (SELECT 1 FROM owner_sections s WHERE s.owner_id = o.owner_id AND s.reported_by NOT IN ${REVOKED_CHARACTERS})`,
      ),
      sections: await count(db, `SELECT COUNT(*) AS n FROM owner_sections WHERE reported_by IN ${REVOKED_CHARACTERS}`),
      items: await count(
        db,
        `SELECT COUNT(*) AS n FROM items i
         JOIN owner_sections s ON s.owner_id = i.owner_id AND s.section = i.section
         WHERE s.reported_by IN ${REVOKED_CHARACTERS}`,
      ),
      journals: await count(db, `SELECT COUNT(*) AS n FROM wondrous_tails WHERE member_id IN ${REVOKED_MEMBERS}`),
    },
    expiredSessions: await count(db, "SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?", nowIso),
    usageRowsOlderThan90Days: await count(db, "SELECT COUNT(*) AS n FROM usage_daily WHERE day < ?", usageCutoff),
  };
  if (dryRun) return report;

  await db.batch([
    // Sections they reported (items go with them: ON DELETE CASCADE).
    db.prepare(`DELETE FROM owner_sections WHERE reported_by IN ${REVOKED_CHARACTERS}`),
    // Owners nothing is left in.
    db.prepare(
      `DELETE FROM owners WHERE reported_by IN ${REVOKED_CHARACTERS}
         AND owner_id NOT IN (SELECT owner_id FROM owner_sections)`,
    ),
    // Shared owners (FC chest, houses) that other members still report: hand them over.
    db.prepare(
      `UPDATE owners SET reported_by = (
         SELECT s.reported_by FROM owner_sections s WHERE s.owner_id = owners.owner_id ORDER BY s.captured_at DESC LIMIT 1)
       WHERE reported_by IN ${REVOKED_CHARACTERS}`,
    ),
    db.prepare(`DELETE FROM wondrous_tails WHERE member_id IN ${REVOKED_MEMBERS}`),
    // Now unreferenced, so the character can be claimed again (e.g. if they rejoin with a new key).
    db.prepare(
      `DELETE FROM characters WHERE content_id IN ${REVOKED_CHARACTERS}
         AND content_id NOT IN (SELECT reported_by FROM owners)
         AND content_id NOT IN (SELECT reported_by FROM owner_sections)
         AND content_id NOT IN (SELECT content_id FROM wondrous_tails)`,
    ),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso),
    db.prepare("DELETE FROM usage_daily WHERE day < ?").bind(usageCutoff),
  ]);
  return report;
}

export interface StaleOwner {
  ownerId: string;
  kind: string;
  name: string | null;
  member: string;
  character: string;
  /** The newest capture of any of its sections. */
  lastCapturedAt: string;
  items: number;
}

/**
 * Owners none of whose sections have been captured for `days`: candidates for removal (usually
 * dismissed retainers). Only a list: the plugin re-sends a section only when it changes, so an
 * untouched but live retainer looks the same, and a person should decide.
 */
export async function staleOwners(db: SqlDatabase, now: Date, days: number): Promise<StaleOwner[]> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = await db
    .prepare(
      `SELECT o.owner_id, o.kind, o.name, m.display_name AS member, c.name AS character,
              MAX(s.captured_at) AS last_captured_at, SUM(s.item_count) AS items
       FROM owners o
       JOIN owner_sections s ON s.owner_id = o.owner_id
       JOIN characters c ON c.content_id = o.reported_by
       JOIN members m ON m.id = c.member_id AND m.revoked_at IS NULL
       GROUP BY o.owner_id
       HAVING MAX(s.captured_at) < ?
       ORDER BY last_captured_at`,
    )
    .bind(cutoff)
    .all<{
      owner_id: string;
      kind: string;
      name: string | null;
      member: string;
      character: string;
      last_captured_at: string;
      items: number;
    }>();
  return rows.results.map((r) => ({
    ownerId: r.owner_id,
    kind: r.kind,
    name: r.name,
    member: r.member,
    character: r.character,
    lastCapturedAt: r.last_captured_at,
    items: r.items,
  }));
}

/** Deletes one owner with all its sections and items. Its next upload, if any, brings it back. */
export async function deleteOwner(db: SqlDatabase, ownerId: string): Promise<{ sections: number; items: number } | null> {
  const sections = await count(db, "SELECT COUNT(*) AS n FROM owner_sections WHERE owner_id = ?", ownerId);
  const items = await count(db, "SELECT COUNT(*) AS n FROM items WHERE owner_id = ?", ownerId);
  const result = await db.prepare("DELETE FROM owners WHERE owner_id = ?").bind(ownerId).run();
  return result.meta.changes > 0 ? { sections, items } : null;
}
