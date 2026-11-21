import type { Member } from "./auth.ts";
import type { Upload, UploadItem } from "./contract.ts";
import type { SqlDatabase, SqlStatement } from "./db/types.ts";
import { HttpError } from "./http-error.ts";
import type { Limits } from "./limits.ts";
import { clampCapturedAt } from "./validation.ts";

/** Kinds that belong to exactly one character; others (FC chest, houses) are shared. */
const PRIVATE_KINDS = new Set(["character", "retainer"]);

/** Max items per INSERT ... json_each(?) statement, keeping each bound JSON well under D1's 2 MB value limit. */
const ITEMS_PER_INSERT = 2_000;

/**
 * The diff path binds a whole section as one JSON string, and D1 caps a bound value at 2 MB.
 * JSON.stringify length counts UTF-16 units; at most 3 UTF-8 bytes each, 600k units stays under
 * 1.8 MB. Real sections are a few hundred items (~50 KB); anything bigger falls back to replace-all.
 */
const MAX_DIFF_JSON_CHARS = 600_000;

export interface IngestResult {
  sectionsWritten: number;
  itemsWritten: number;
  /** Sections the server already has newer data for (e.g. the FC chest after a mate's newer upload). */
  sectionsSkippedStale: string[];
  /** Owners that belong to someone else's character, or new owners past the per-character cap. */
  ownersRejected: string[];
}

export async function ingestUpload(
  db: SqlDatabase,
  member: Member,
  upload: Upload,
  limits: Pick<Limits, "ownersPerCharacter">,
  now = new Date(),
): Promise<IngestResult> {
  const { character } = upload;
  const capturedAt = clampCapturedAt(upload.capturedAt, now);

  const upsertCharacter = await claimCharacter(db, member, character, now);

  const ownerIds = JSON.stringify(upload.owners.map((o) => o.ownerId));
  const existingOwners = await db
    .prepare("SELECT owner_id, kind, reported_by FROM owners WHERE owner_id IN (SELECT value FROM json_each(?))")
    .bind(ownerIds)
    .all<{ owner_id: string; kind: string; reported_by: string }>();
  const existingSections = await db
    .prepare("SELECT owner_id, section, captured_at FROM owner_sections WHERE owner_id IN (SELECT value FROM json_each(?))")
    .bind(ownerIds)
    .all<{ owner_id: string; section: string; captured_at: string }>();

  // New owners count against a per-character cap, so a buggy or hostile client can't create
  // unlimited owners (each one grows storage and every scan of it).
  const owned = await db.prepare("SELECT COUNT(*) AS n FROM owners WHERE reported_by = ?").bind(character.contentId).first<{ n: number }>();
  let ownerCount = owned?.n ?? 0;

  const ownerById = new Map(existingOwners.results.map((o) => [o.owner_id, o]));
  const sectionTime = new Map(existingSections.results.map((s) => [`${s.owner_id}\u0000${s.section}`, s.captured_at]));

  const result: IngestResult = { sectionsWritten: 0, itemsWritten: 0, sectionsSkippedStale: [], ownersRejected: [] };
  const statements: SqlStatement[] = [upsertCharacter];

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

    statements.push(
      db
        .prepare(
          `INSERT INTO owners (owner_id, kind, name, reported_by, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (owner_id) DO UPDATE SET
             kind = excluded.kind, name = COALESCE(excluded.name, owners.name),
             reported_by = excluded.reported_by, updated_at = excluded.updated_at`,
        )
        .bind(owner.ownerId, owner.kind, owner.name, character.contentId, capturedAt),
    );

    for (const section of owner.sections) {
      const known = sectionTime.get(`${owner.ownerId}\u0000${section.section}`);
      if (known !== undefined && known > capturedAt) {
        result.sectionsSkippedStale.push(`${owner.ownerId}/${section.section}`);
        continue;
      }

      statements.push(
        // owner_sections must exist before items reference it (FK), so upsert it first.
        db
          .prepare(
            `INSERT INTO owner_sections (owner_id, section, captured_at, reported_by, item_count) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, section) DO UPDATE SET
               captured_at = excluded.captured_at, reported_by = excluded.reported_by, item_count = excluded.item_count`,
          )
          .bind(owner.ownerId, section.section, capturedAt, character.contentId, section.items.length),
        ...syncSectionItems(db, owner.ownerId, section.section, section.items),
      );
      result.sectionsWritten++;
      result.itemsWritten += section.items.length;
    }
  }

  await db.batch(statements);
  return result;
}

/**
 * Characters belong to the member whose key first uploaded them. Throws 403 if another member
 * owns `character`; otherwise returns the upsert statement to run in the caller's batch.
 */
export async function claimCharacter(db: SqlDatabase, member: Member, character: Upload["character"], now: Date): Promise<SqlStatement> {
  const claim = await db
    .prepare("SELECT member_id FROM characters WHERE content_id = ?")
    .bind(character.contentId)
    .first<{ member_id: number }>();
  if (claim && claim.member_id !== member.id) {
    throw new HttpError(403, "rejected", "This character is registered to another member.");
  }

  return db
    .prepare(
      `INSERT INTO characters (content_id, member_id, name, home_world_id, home_world, last_upload_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_id) DO UPDATE SET
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

/** Deletes stored rows the upload no longer has. */
export const DELETE_REMOVED_SQL = `${DIFF_CTES}
  DELETE FROM items WHERE rowid IN (
    SELECT c.rid FROM current_n c
    WHERE NOT EXISTS (SELECT 1 FROM incoming_n i WHERE ${SAME_ROW})
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
  WHERE NOT EXISTS (SELECT 1 FROM current_n c WHERE ${SAME_ROW})`;

/**
 * Makes the stored items of one section equal to `items`, writing only the rows that differ.
 *
 * D1 bills every row written, and each items row also updates two indexes, so replacing a whole
 * 140-slot bag when one stack changes cost ~840 rows written. The diff costs a few rows per changed
 * stack. Both statements run inside the caller's batch (one transaction), so concurrent uploads of a
 * shared section (FC chest, houses) can't interleave mid-diff.
 */
export function syncSectionItems(db: SqlDatabase, ownerId: string, section: string, items: UploadItem[]): SqlStatement[] {
  const packed = JSON.stringify(items.map(packItem));
  if (packed.length > MAX_DIFF_JSON_CHARS) {
    return replaceSectionItems(db, ownerId, section, items);
  }
  return [db.prepare(DELETE_REMOVED_SQL).bind(ownerId, section, packed), db.prepare(INSERT_ADDED_SQL).bind(ownerId, section, packed)];
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

/** Fallback for oversized sections: delete everything, then bulk insert in chunks. */
function replaceSectionItems(db: SqlDatabase, ownerId: string, section: string, items: UploadItem[]): SqlStatement[] {
  const statements: SqlStatement[] = [db.prepare("DELETE FROM items WHERE owner_id = ? AND section = ?").bind(ownerId, section)];
  for (let start = 0; start < items.length; start += ITEMS_PER_INSERT) {
    const chunk = JSON.stringify(items.slice(start, start + ITEMS_PER_INSERT).map(packItem));
    statements.push(
      db
        .prepare(
          `INSERT INTO items (owner_id, section, ${COLUMN_LIST})
           SELECT ?1, ?2, ${ITEM_COLUMNS.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ")}
           FROM json_each(?3)`,
        )
        .bind(ownerId, section, chunk),
    );
  }
  return statements;
}
