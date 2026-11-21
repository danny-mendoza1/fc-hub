import type { Member } from "./auth.ts";
import type { SqlDatabase } from "./db/types.ts";
import { claimCharacter } from "./ingest.ts";
import { clampCapturedAt } from "./validation.ts";
import { bookStatus, type StoredBook, type WondrousTailsResponse, type WtBook, type WtSlot, type WtUpload, weeklyResets } from "./wondrous-tails.ts";

interface Row {
  member_id: number;
  content_id: string;
  has_journal: number;
  is_expired: number;
  expires_at: string | null;
  second_chance_points: number;
  stickers_placed: number;
  slots: string;
  captured_at: string;
  turned_in_at: string | null;
  turned_in_expires_at: string | null;
}


/**
 * Stores a member's journal (replacing their previous one, even if it came from another
 * character). If a still-valid journal has disappeared since the last upload, records it as
 * handed in.
 */
export async function saveWondrousTails(
  db: SqlDatabase,
  member: Member,
  upload: WtUpload,
  now = new Date(),
): Promise<{ status: string; turnedInInferred: boolean }> {
  const capturedAt = clampCapturedAt(upload.capturedAt, now);
  const upsertCharacter = await claimCharacter(db, member, upload.character, now);

  const previous = await db.prepare("SELECT * FROM wondrous_tails WHERE member_id = ?").bind(member.id).first<Row>();
  if (previous && previous.captured_at > capturedAt) {
    return { status: "stale", turnedInInferred: false };
  }

  let turnedInAt: string | null = null;
  let turnedInExpiresAt: string | null = null;
  let turnedInInferred = false;
  if (!upload.hasJournal && previous && previous.content_id === upload.character.contentId) {
    const previousStillValid =
      previous.has_journal === 1 && previous.is_expired === 0 && previous.expires_at !== null && previous.expires_at > capturedAt;
    if (previousStillValid) {
      turnedInAt = capturedAt;
      turnedInExpiresAt = previous.expires_at;
      turnedInInferred = true;
    } else if (previous.has_journal === 0) {
      // Still no journal: keep what we knew about the last hand-in.
      turnedInAt = previous.turned_in_at;
      turnedInExpiresAt = previous.turned_in_expires_at;
    }
  }

  await db.batch([
    upsertCharacter,
    db
      .prepare(
        `INSERT INTO wondrous_tails (member_id, content_id, has_journal, is_expired, expires_at, second_chance_points,
                                     stickers_placed, slots, captured_at, turned_in_at, turned_in_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (member_id) DO UPDATE SET
           content_id = excluded.content_id, has_journal = excluded.has_journal, is_expired = excluded.is_expired,
           expires_at = excluded.expires_at, second_chance_points = excluded.second_chance_points,
           stickers_placed = excluded.stickers_placed, slots = excluded.slots, captured_at = excluded.captured_at,
           turned_in_at = excluded.turned_in_at, turned_in_expires_at = excluded.turned_in_expires_at`,
      )
      .bind(
        member.id,
        upload.character.contentId,
        upload.hasJournal ? 1 : 0,
        upload.isExpired ? 1 : 0,
        upload.expiresAt,
        upload.secondChancePoints,
        upload.stickersPlaced,
        JSON.stringify(upload.slots),
        capturedAt,
        turnedInAt,
        turnedInExpiresAt,
      ),
  ]);

  const stored: StoredBook = {
    hasJournal: upload.hasJournal,
    isExpired: upload.isExpired,
    expiresAt: upload.expiresAt,
    capturedAt,
    turnedInAt,
    turnedInExpiresAt,
  };
  return { status: bookStatus(stored, now).status, turnedInInferred };
}

/** Every active member's book (members who never uploaded appear as "unknown"). */
export async function listWondrousTails(db: SqlDatabase, now = new Date()): Promise<WondrousTailsResponse> {
  const rows = await db
    .prepare(
      `SELECT m.id AS member_id, m.display_name AS member, c.name AS character_name, c.home_world, wt.*
       FROM members m
       LEFT JOIN wondrous_tails wt ON wt.member_id = m.id
       LEFT JOIN characters c ON c.content_id = wt.content_id
       WHERE m.revoked_at IS NULL
       ORDER BY m.display_name COLLATE NOCASE`,
    )
    .all<Partial<Row> & { member_id: number; member: string; character_name: string | null; home_world: string | null }>();

  const books: WtBook[] = rows.results.map((row) => {
    const stored: StoredBook | null =
      row.captured_at === undefined || row.captured_at === null
        ? null
        : {
            hasJournal: row.has_journal === 1,
            isExpired: row.is_expired === 1,
            expiresAt: row.expires_at ?? null,
            capturedAt: row.captured_at,
            turnedInAt: row.turned_in_at ?? null,
            turnedInExpiresAt: row.turned_in_expires_at ?? null,
          };
    const { status, stale, newJournalAvailable } = bookStatus(stored, now);
    return {
      memberId: row.member_id,
      member: row.member,
      character: row.character_name,
      homeWorld: row.home_world,
      status,
      stale,
      newJournalAvailable,
      capturedAt: stored?.capturedAt ?? null,
      expiresAt: stored?.expiresAt ?? null,
      secondChancePoints: row.second_chance_points ?? 0,
      stickersPlaced: row.stickers_placed ?? 0,
      slots: stored?.hasJournal && row.slots ? (JSON.parse(row.slots) as WtSlot[]) : [],
    };
  });

  const { lastReset, nextReset } = weeklyResets(now);
  return { lastReset: lastReset.toISOString(), nextReset: nextReset.toISOString(), books };
}
