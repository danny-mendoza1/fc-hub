import type { Member } from "./auth.ts";
import type { Upload, UploadItem } from "./contract.ts";
import type { SqlDatabase, SqlStatement } from "./db/types.ts";

/** Kinds that belong to exactly one character; others (FC chest, houses) are shared. */
const PRIVATE_KINDS = new Set(["character", "retainer"]);

/** Max items per INSERT ... json_each(?) statement, keeping each bound JSON well under D1's 2 MB value limit. */
const ITEMS_PER_INSERT = 2_000;

/** Client clocks drift; never accept a capture time in the future. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface IngestResult {
  sectionsWritten: number;
  itemsWritten: number;
  /** Sections the server already has newer data for (e.g. the FC chest after a mate's newer upload). */
  sectionsSkippedStale: string[];
  /** Owners that belong to someone else's character. */
  ownersRejected: string[];
}

export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function ingestUpload(db: SqlDatabase, member: Member, upload: Upload, now = new Date()): Promise<IngestResult> {
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
        db.prepare("DELETE FROM items WHERE owner_id = ? AND section = ?").bind(owner.ownerId, section.section),
        db
          .prepare(
            `INSERT INTO owner_sections (owner_id, section, captured_at, reported_by, item_count) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, section) DO UPDATE SET
               captured_at = excluded.captured_at, reported_by = excluded.reported_by, item_count = excluded.item_count`,
          )
          .bind(owner.ownerId, section.section, capturedAt, character.contentId, section.items.length),
        ...insertItems(db, owner.ownerId, section.section, section.items),
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
export async function claimCharacter(
  db: SqlDatabase,
  member: Member,
  character: Upload["character"],
  now: Date,
): Promise<SqlStatement> {
  const claim = await db
    .prepare("SELECT member_id FROM characters WHERE content_id = ?")
    .bind(character.contentId)
    .first<{ member_id: number }>();
  if (claim && claim.member_id !== member.id) {
    throw new IngestError(403, "This character is registered to another member.");
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

/** Bulk insert via json_each: one statement (one bound JSON string) per chunk instead of one per item. */
function insertItems(db: SqlDatabase, ownerId: string, section: string, items: UploadItem[]): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (let start = 0; start < items.length; start += ITEMS_PER_INSERT) {
    const chunk = items.slice(start, start + ITEMS_PER_INSERT);
    statements.push(
      db
        .prepare(
          `INSERT INTO items (owner_id, section, item_id, name, icon_id, quantity, is_hq, is_collectable,
                              container, sorted_container, sorted_slot, location)
           SELECT ?1, ?2,
                  json_extract(value, '$.itemId'), json_extract(value, '$.name'), json_extract(value, '$.iconId'),
                  json_extract(value, '$.quantity'), json_extract(value, '$.isHq'), json_extract(value, '$.isCollectable'),
                  json_extract(value, '$.container'), json_extract(value, '$.sortedContainer'),
                  json_extract(value, '$.sortedSlot'), json_extract(value, '$.location')
           FROM json_each(?3)`,
        )
        .bind(ownerId, section, JSON.stringify(chunk)),
    );
  }
  return statements;
}

function clampCapturedAt(capturedAt: string, now: Date): string {
  const time = Date.parse(capturedAt);
  const latest = now.getTime() + MAX_CLOCK_SKEW_MS;
  return new Date(Math.min(time, latest)).toISOString();
}
