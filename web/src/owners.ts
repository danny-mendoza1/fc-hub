import { ACTIVE_MEMBER } from "./db/scopes.ts";
import type { SqlDatabase } from "./db/types.ts";

/** Queries behind "Inventories": who has uploaded what, and one owner's items. */

export interface OverviewOwner {
  ownerId: string;
  kind: string;
  name: string | null;
  sections: { section: string; itemCount: number; capturedAt: string }[];
}

export interface OverviewCharacter {
  member: string;
  contentId: string;
  name: string;
  homeWorld: string | null;
  lastUploadAt: string;
  owners: OverviewOwner[];
}

/** Who has uploaded what, and how fresh each section is. */
export async function overview(db: SqlDatabase): Promise<OverviewCharacter[]> {
  const rows = await db
    .prepare(
      `SELECT m.display_name AS member, c.content_id, c.name, c.home_world, c.last_upload_at,
              o.owner_id, o.kind, o.name AS owner_name, s.section, s.item_count, s.captured_at
       FROM characters c
       JOIN members m ON m.id = c.member_id
       LEFT JOIN owner_sections s ON s.reported_by = c.content_id
       LEFT JOIN owners o ON o.owner_id = s.owner_id
       WHERE ${ACTIVE_MEMBER}
       ORDER BY m.display_name, c.name, o.kind, o.name, s.section`,
    )
    .all<{
      member: string;
      content_id: string;
      name: string;
      home_world: string | null;
      last_upload_at: string;
      owner_id: string | null;
      kind: string | null;
      owner_name: string | null;
      section: string | null;
      item_count: number | null;
      captured_at: string | null;
    }>();

  const characters = new Map<string, OverviewCharacter>();
  for (const row of rows.results) {
    let character = characters.get(row.content_id);
    if (!character) {
      character = {
        member: row.member,
        contentId: row.content_id,
        name: row.name,
        homeWorld: row.home_world,
        lastUploadAt: row.last_upload_at,
        owners: [],
      };
      characters.set(row.content_id, character);
    }
    if (!row.owner_id || !row.section) continue;

    let owner = character.owners.find((o) => o.ownerId === row.owner_id);
    if (!owner) {
      owner = { ownerId: row.owner_id, kind: row.kind ?? "unknown", name: row.owner_name, sections: [] };
      character.owners.push(owner);
    }
    owner.sections.push({ section: row.section, itemCount: row.item_count ?? 0, capturedAt: row.captured_at ?? "" });
  }

  return [...characters.values()];
}

export interface OwnerItem {
  itemId: number;
  name: string;
  iconId: number;
  quantity: number;
  isHq: boolean;
  isCollectable: boolean;
  sortedContainer: number;
  sortedSlot: number;
  location: string;
}

export interface OwnerSection {
  section: string;
  itemCount: number;
  capturedAt: string;
  /** Shared sections: when these contents were last seen in game, if the reporter saw them (ADR 0008). */
  observedAt: string | null;
  /** Whose upload this section came from (matters for the shared FC chest and houses). */
  reportedBy: { member: string; character: string };
  items: OwnerItem[];
}

export interface OwnerItems {
  owner: { ownerId: string; kind: string; name: string | null };
  sections: OwnerSection[];
}

/** Everything one owner (character, retainer, FC chest, house) holds, by section, in bag/slot order. */
export async function ownerItems(db: SqlDatabase, ownerId: string): Promise<OwnerItems | null> {
  const owner = await db
    .prepare("SELECT owner_id, kind, name FROM owners WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ owner_id: string; kind: string; name: string | null }>();
  if (!owner) return null;

  const [sections, items] = await Promise.all([
    db
      .prepare(
        `SELECT s.section, s.item_count, s.captured_at, s.observed_at, c.name AS character_name, m.display_name AS member_name
         FROM owner_sections s
         JOIN characters c ON c.content_id = s.reported_by
         JOIN members m ON m.id = c.member_id
         WHERE s.owner_id = ? AND ${ACTIVE_MEMBER}`,
      )
      .bind(ownerId)
      .all<{
        section: string;
        item_count: number;
        captured_at: string;
        observed_at: string | null;
        character_name: string;
        member_name: string;
      }>(),
    db
      .prepare(
        `SELECT section, item_id, name, icon_id, quantity, is_hq, is_collectable, sorted_container, sorted_slot, location
         FROM items WHERE owner_id = ?
         ORDER BY section, sorted_container, sorted_slot`,
      )
      .bind(ownerId)
      .all<{
        section: string;
        item_id: number;
        name: string;
        icon_id: number;
        quantity: number;
        is_hq: number;
        is_collectable: number;
        sorted_container: number;
        sorted_slot: number;
        location: string;
      }>(),
  ]);

  const bySection = new Map<string, OwnerSection>(
    sections.results.map((s) => [
      s.section,
      {
        section: s.section,
        itemCount: s.item_count,
        capturedAt: s.captured_at,
        observedAt: s.observed_at,
        reportedBy: { member: s.member_name, character: s.character_name },
        items: [],
      },
    ]),
  );
  for (const row of items.results) {
    bySection.get(row.section)?.items.push({
      itemId: row.item_id,
      name: row.name,
      iconId: row.icon_id,
      quantity: row.quantity,
      isHq: row.is_hq === 1,
      isCollectable: row.is_collectable === 1,
      sortedContainer: row.sorted_container,
      sortedSlot: row.sorted_slot,
      location: row.location,
    });
  }

  // Nothing visible (e.g. the member who uploaded it was revoked): don't reveal even the owner's name.
  if (bySection.size === 0) return null;
  return {
    owner: { ownerId: owner.owner_id, kind: owner.kind, name: owner.name },
    sections: [...bySection.values()],
  };
}
