import type { Member } from "./auth.ts";
import type { Upload, UploadItem } from "./contract.ts";
import type { SqlDatabase, SqlStatement } from "./db/types.ts";
import { HttpError } from "./http-error.ts";
import type { Limits } from "./limits.ts";
import { clampCapturedAt } from "./validation.ts";

/** Kinds that belong to exactly one character; others (FC chest, houses) are shared. */
const PRIVATE_KINDS = new Set(["character", "retainer"]);
const PRIVATE_KINDS_SQL = `(${[...PRIVATE_KINDS].map((k) => `'${k}'`).join(", ")})`;

/** Max items per INSERT ... json_each(?) statement, keeping each bound JSON well under D1's 2 MB value limit. */
const ITEMS_PER_INSERT = 2_000;

/**
 * The diff path binds a whole section as one JSON string, and D1 caps a bound value at 2 MB.
 * JSON.stringify length counts UTF-16 units; at most 3 UTF-8 bytes each, 600k units stays under
 * 1.8 MB. Real sections are a few hundred items (~50 KB); anything bigger falls back to replace-all.
 */
const MAX_DIFF_JSON_CHARS = 600_000;

const CLAIMED_BY_OTHER = "This character is registered to another member.";

export interface IngestResult {
  sectionsWritten: number;
  itemsWritten: number;
  /** Sections the server already has fresher data for (e.g. the FC chest after a mate saw it more recently). */
  sectionsSkippedStale: string[];
  /** Owners that belong to someone else's character, or new owners past the per-character cap. */
  ownersRejected: string[];
}

/** The section row an upload writes: its items are applied only while the row is still this one. */
interface SectionHolder {
  capturedAt: string;
  reportedBy: string;
}

/** How fresh a section's contents are: when last reported, and when last seen in game (if known). */
export interface SectionFreshness {
  capturedAt: string;
  observedAt: string | null;
}

/**
 * Whether a report may replace what's stored for a section (ADR 0008). A sighting in game outranks
 * any report: a plugin re-sending Allagan Tools' cache (fresh install, "Re-upload everything", an
 * alt, a retry) stamps old contents with a new capturedAt, so report time can't beat a sighting.
 * Between two sightings, or two reports, the newer one wins. Mirrors {@link REPLACES_SQL}.
 */
export function replaces(incoming: SectionFreshness, stored: SectionFreshness): boolean {
  if (incoming.observedAt !== null && stored.observedAt !== null) return incoming.observedAt >= stored.observedAt;
  if (incoming.observedAt !== null) return true;
  if (stored.observedAt !== null) return false;
  return incoming.capturedAt >= stored.capturedAt;
}

/** {@link replaces} as the section upsert's WHERE: `excluded` is the incoming report. Keep the two in step. */
const REPLACES_SQL = `CASE
    WHEN excluded.observed_at IS NOT NULL AND owner_sections.observed_at IS NOT NULL THEN excluded.observed_at >= owner_sections.observed_at
    WHEN excluded.observed_at IS NOT NULL THEN 1
    WHEN owner_sections.observed_at IS NOT NULL THEN 0
    ELSE excluded.captured_at >= owner_sections.captured_at
  END`;

/** A sighting can't be later than the snapshot that reports it; normalised like capturedAt. */
function clampObservedAt(observedAt: string | null | undefined, capturedAt: string): string | null {
  if (observedAt === null || observedAt === undefined) return null;
  return new Date(Math.min(Date.parse(observedAt), Date.parse(capturedAt))).toISOString();
}

/**
 * Applies an upload in one transaction.
 *
 * The reads before the batch answer the common case quickly and precisely (which owners to reject,
 * which sections already hold fresher data) and avoid sending stale sections at all. They can't
 * keep the data right on their own: another upload can commit between them and the batch. So
 * every rule they check is enforced again by the batch's own SQL, where D1 runs it atomically:
 * the character claim and private owners (a lost race rolls the batch back; see commitUpload), and
 * section freshness ({@link replaces}: a staler report changes nothing, even if it commits last).
 */
export async function ingestUpload(
  db: SqlDatabase,
  member: Member,
  upload: Upload,
  limits: Pick<Limits, "ownersPerCharacter">,
  now = new Date(),
): Promise<IngestResult> {
  const { character } = upload;
  const capturedAt = clampCapturedAt(upload.capturedAt, now);
  const holder: SectionHolder = { capturedAt, reportedBy: character.contentId };

  const upsertCharacter = await claimCharacter(db, member, character, now);

  const ownerIds = JSON.stringify(upload.owners.map((o) => o.ownerId));
  const existingOwners = await db
    .prepare("SELECT owner_id, kind, reported_by FROM owners WHERE owner_id IN (SELECT value FROM json_each(?))")
    .bind(ownerIds)
    .all<{ owner_id: string; kind: string; reported_by: string }>();
  const existingSections = await db
    .prepare("SELECT owner_id, section, captured_at, observed_at FROM owner_sections WHERE owner_id IN (SELECT value FROM json_each(?))")
    .bind(ownerIds)
    .all<{ owner_id: string; section: string; captured_at: string; observed_at: string | null }>();

  // New owners count against a per-character cap, so a buggy or hostile client can't create
  // unlimited owners (each one grows storage and every scan of it).
  const owned = await db.prepare("SELECT COUNT(*) AS n FROM owners WHERE reported_by = ?").bind(character.contentId).first<{ n: number }>();
  let ownerCount = owned?.n ?? 0;

  const ownerById = new Map(existingOwners.results.map((o) => [o.owner_id, o]));
  const storedSections = new Map<string, SectionFreshness>(
    existingSections.results.map((s) => [`${s.owner_id}\u0000${s.section}`, { capturedAt: s.captured_at, observedAt: s.observed_at }]),
  );

  const result: IngestResult = { sectionsWritten: 0, itemsWritten: 0, sectionsSkippedStale: [], ownersRejected: [] };
  const statements: SqlStatement[] = [upsertCharacter];
  /** Each section sent: where its upsert sits in `statements`, so the batch result says if it won. */
  const sent: { statement: number; key: string; items: number }[] = [];

  for (const owner of upload.owners) {
    const existing = ownerById.get(owner.ownerId);
    const isPrivate = PRIVATE_KINDS.has(owner.kind) || (existing !== undefined && PRIVATE_KINDS.has(existing.kind));
    const characterMismatch = owner.kind === "character" && owner.ownerId !== character.contentId;
    if (characterMismatch || (isPrivate && existing && existing.reported_by !== character.contentId)) {
      result.ownersRejected.push(owner.ownerId);
      continue;
    }
    if (existing === undefined) {
      if (ownerCount >= limits.ownersPerCharacter) {
        result.ownersRejected.push(owner.ownerId);
        continue;
      }
      ownerCount++;
    }

    statements.push(db.prepare(UPSERT_OWNER_SQL).bind(owner.ownerId, owner.kind, owner.name, character.contentId, capturedAt));

    for (const section of owner.sections) {
      const key = `${owner.ownerId}/${section.section}`;
      const report: SectionFreshness = { capturedAt, observedAt: clampObservedAt(section.observedAt, capturedAt) };
      const known = storedSections.get(`${owner.ownerId}\u0000${section.section}`);
      if (known !== undefined && !replaces(report, known)) {
        result.sectionsSkippedStale.push(key);
        continue;
      }

      sent.push({ statement: statements.length, key, items: section.items.length });
      statements.push(
        // owner_sections must exist before items reference it (FK), so upsert it first.
        db
          .prepare(UPSERT_SECTION_SQL)
          .bind(owner.ownerId, section.section, capturedAt, report.observedAt, character.contentId, section.items.length),
        ...syncSectionItems(db, owner.ownerId, section.section, section.items, holder),
      );
    }
  }

  const results = await commitUpload(db, statements);

  // A section upsert changes no row when a fresher report committed after our reads; its item
  // statements then did nothing either, so the section was stale after all.
  for (const s of sent) {
    if (changesBy(results[s.statement]) > 0) {
      result.sectionsWritten++;
      result.itemsWritten += s.items;
    } else {
      result.sectionsSkippedStale.push(s.key);
    }
  }
  return result;
}

/**
 * Owners upsert. A private owner (character, retainer) never changes hands: if another character
 * already reports it, `reported_by` becomes NULL, which fails NOT NULL and rolls back the batch.
 * ingestUpload's reads reject this up front; this catches an upload that claimed it in between.
 */
const UPSERT_OWNER_SQL = `INSERT INTO owners (owner_id, kind, name, reported_by, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (owner_id) DO UPDATE SET
    kind = excluded.kind, name = COALESCE(excluded.name, owners.name),
    reported_by = CASE
      WHEN owners.reported_by <> excluded.reported_by
       AND (owners.kind IN ${PRIVATE_KINDS_SQL} OR excluded.kind IN ${PRIVATE_KINDS_SQL}) THEN NULL
      ELSE excluded.reported_by
    END,
    updated_at = excluded.updated_at`;

/**
 * Section upsert. Only a report that {@link replaces} the stored one gets in; a staler one changes
 * no row (and the batch result shows 0 changes), and the item statements after it, guarded by
 * {@link holdsSection}, leave the items alone too.
 */
const UPSERT_SECTION_SQL = `INSERT INTO owner_sections (owner_id, section, captured_at, observed_at, reported_by, item_count)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (owner_id, section) DO UPDATE SET
    captured_at = excluded.captured_at, observed_at = excluded.observed_at,
    reported_by = excluded.reported_by, item_count = excluded.item_count
  WHERE ${REPLACES_SQL}`;

/**
 * True while the section row (owner ?1, section ?2) is this upload's: its capture time and
 * reporter are the ones bound at `at` and `by`. False when a newer report holds the section.
 */
function holdsSection(at: string, by: string): string {
  return `EXISTS (SELECT 1 FROM owner_sections held WHERE held.owner_id = ?1 AND held.section = ?2 AND held.captured_at = ${at} AND held.reported_by = ${by})`;
}

/**
 * Runs an upload's statements, which start with {@link claimCharacter}'s upsert, as one transaction.
 * When a guard in the SQL rolls it back, answers as the up-front checks would have: 403 when another
 * member claimed the character, 409 (retry) when another character claimed a private owner.
 */
export async function commitUpload(db: SqlDatabase, statements: SqlStatement[]): Promise<unknown[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (notNullFailed(error, "characters.member_id")) throw new HttpError(403, "rejected", CLAIMED_BY_OTHER);
    if (notNullFailed(error, "owners.reported_by")) {
      throw new HttpError(
        409,
        "conflict",
        "Another character reported one of these retainers at the same moment; the upload will be retried.",
      );
    }
    throw error;
  }
}

/** SQLite's NOT NULL failure on `column`. node:sqlite and D1 both carry SQLite's message (D1 sometimes on `cause`). */
function notNullFailed(error: unknown, column: string): boolean {
  const text = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
  const needle = `NOT NULL constraint failed: ${column}`;
  return text(error).includes(needle) || text((error as { cause?: unknown } | null)?.cause).includes(needle);
}

/** Rows a batch statement changed (D1 and node:sqlite both report `meta.changes`). */
function changesBy(result: unknown): number {
  return (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
}

/**
 * Characters belong to the member whose key first uploaded them. Throws 403 if another member
 * owns `character`; otherwise returns the upsert statement to run in the caller's batch, which must
 * go through {@link commitUpload}. The upsert re-checks the claim: if another member claimed the
 * character since this read, `member_id` becomes NULL, fails NOT NULL, and the batch rolls back.
 */
export async function claimCharacter(db: SqlDatabase, member: Member, character: Upload["character"], now: Date): Promise<SqlStatement> {
  const claim = await db
    .prepare("SELECT member_id FROM characters WHERE content_id = ?")
    .bind(character.contentId)
    .first<{ member_id: number }>();
  if (claim && claim.member_id !== member.id) {
    throw new HttpError(403, "rejected", CLAIMED_BY_OTHER);
  }

  return db
    .prepare(
      `INSERT INTO characters (content_id, member_id, name, home_world_id, home_world, last_upload_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_id) DO UPDATE SET
         member_id = CASE WHEN characters.member_id = excluded.member_id THEN characters.member_id ELSE NULL END,
         name = excluded.name, home_world_id = excluded.home_world_id,
         home_world = excluded.home_world, last_upload_at = excluded.last_upload_at`,
    )
    .bind(character.contentId, member.id, character.name, character.homeWorldId, character.homeWorld, now.toISOString());
}

/**
 * Item columns in the order the diff path packs them: each item travels as a JSON array
 * `[itemId, name, iconId, quantity, isHq, isCollectable, container, sortedContainer, sortedSlot, location]`.
 */
const ITEM_COLUMNS = [
  "item_id",
  "name",
  "icon_id",
  "quantity",
  "is_hq",
  "is_collectable",
  "container",
  "sorted_container",
  "sorted_slot",
  "location",
] as const;

const COLUMN_LIST = ITEM_COLUMNS.join(", ");
const PARTITION = `PARTITION BY ${COLUMN_LIST}`;
const SAME_ROW = `${ITEM_COLUMNS.map((c) => `i.${c} = c.${c}`).join(" AND ")} AND i.n = c.n`;

/**
 * `incoming_n`: the uploaded items. `current_n`: what the table holds for this section. Both number
 * identical rows 1..k (`n`), so matching on every column plus `n` is a multiset comparison:
 * two identical stacks stay two rows, and dropping one of them deletes exactly one row.
 * Bound values: ?1 owner, ?2 section, ?3 packed items, ?4/?5 the section holder (see holdsSection).
 */
const DIFF_CTES = `
  WITH incoming AS (
    SELECT ${ITEM_COLUMNS.map((c, index) => `json_extract(value, '$[${index}]') AS ${c}`).join(", ")}
    FROM json_each(?3)
  ),
  incoming_n AS (
    SELECT *, row_number() OVER (${PARTITION}) AS n FROM incoming
  ),
  current_n AS (
    SELECT rowid AS rid, ${COLUMN_LIST}, row_number() OVER (${PARTITION} ORDER BY rowid) AS n
    FROM items WHERE owner_id = ?1 AND section = ?2
  )`;

/**
 * Deletes stored rows the upload no longer has (only while the upload holds the section).
 *
 * Row-value `NOT IN`, not a correlated `NOT EXISTS` like the insert: with `NOT EXISTS` here,
 * SQLite's automatic index on `incoming_n` covered only `n` (almost always 1), so every stored row
 * was compared with every uploaded one, quadratic in section size (65 ms for a 2,000-item section
 * locally vs 13 ms now; `npm run bench`). `NOT IN` builds one index over all the columns. Every
 * `items` column is NOT NULL, so `NOT IN` and `NOT EXISTS` mean the same thing. The insert keeps
 * `NOT EXISTS`, where the planner already indexes every column and `NOT IN` measured slower.
 */
export const DELETE_REMOVED_SQL = `${DIFF_CTES}
  DELETE FROM items WHERE ${holdsSection("?4", "?5")} AND rowid IN (
    SELECT rid FROM current_n
    WHERE (${COLUMN_LIST}, n) NOT IN (SELECT ${COLUMN_LIST}, n FROM incoming_n)
  )`;

/**
 * Inserts uploaded rows the table doesn't have yet. Runs after DELETE_REMOVED_SQL in the same
 * transaction: what survives the delete is, per identical group, ranks 1..min(stored, uploaded),
 * so the ranks above that are exactly the rows to add.
 */
export const INSERT_ADDED_SQL = `${DIFF_CTES}
  INSERT INTO items (owner_id, section, ${COLUMN_LIST})
  SELECT ?1, ?2, ${ITEM_COLUMNS.map((c) => `i.${c}`).join(", ")}
  FROM incoming_n i
  WHERE ${holdsSection("?4", "?5")} AND NOT EXISTS (SELECT 1 FROM current_n c WHERE ${SAME_ROW})`;

/**
 * Makes the stored items of one section equal to `items`, writing only the rows that differ.
 *
 * D1 bills every row written, and each items row also updates two indexes, so replacing a whole
 * 140-slot bag when one stack changes cost ~840 rows written. The diff costs a few rows per changed
 * stack. Both statements run inside the caller's batch (one transaction), so concurrent uploads of a
 * shared section (FC chest, houses) can't interleave mid-diff, and both do nothing unless the
 * section row (upserted just before them) is still `holder`'s, so an older report never lands.
 */
export function syncSectionItems(
  db: SqlDatabase,
  ownerId: string,
  section: string,
  items: UploadItem[],
  holder: SectionHolder,
): SqlStatement[] {
  const packed = JSON.stringify(items.map(packItem));
  if (packed.length > MAX_DIFF_JSON_CHARS) {
    return replaceSectionItems(db, ownerId, section, items, holder);
  }
  return [
    db.prepare(DELETE_REMOVED_SQL).bind(ownerId, section, packed, holder.capturedAt, holder.reportedBy),
    db.prepare(INSERT_ADDED_SQL).bind(ownerId, section, packed, holder.capturedAt, holder.reportedBy),
  ];
}

function packItem(item: UploadItem): SqlValueTuple {
  return [
    item.itemId,
    item.name,
    item.iconId,
    item.quantity,
    item.isHq ? 1 : 0,
    item.isCollectable ? 1 : 0,
    item.container,
    item.sortedContainer,
    item.sortedSlot,
    item.location,
  ];
}

type SqlValueTuple = [number, string, number, number, 0 | 1, 0 | 1, number, number, number, string];

/** Fallback for oversized sections: delete everything, then bulk insert in chunks (same holder guard). */
function replaceSectionItems(
  db: SqlDatabase,
  ownerId: string,
  section: string,
  items: UploadItem[],
  holder: SectionHolder,
): SqlStatement[] {
  const statements: SqlStatement[] = [
    db
      .prepare(`DELETE FROM items WHERE owner_id = ?1 AND section = ?2 AND ${holdsSection("?3", "?4")}`)
      .bind(ownerId, section, holder.capturedAt, holder.reportedBy),
  ];
  for (let start = 0; start < items.length; start += ITEMS_PER_INSERT) {
    const chunk = JSON.stringify(items.slice(start, start + ITEMS_PER_INSERT).map(packItem));
    statements.push(
      db
        .prepare(
          `INSERT INTO items (owner_id, section, ${COLUMN_LIST})
           SELECT ?1, ?2, ${ITEM_COLUMNS.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ")}
           FROM json_each(?3) WHERE ${holdsSection("?4", "?5")}`,
        )
        .bind(ownerId, section, chunk, holder.capturedAt, holder.reportedBy),
    );
  }
  return statements;
}
