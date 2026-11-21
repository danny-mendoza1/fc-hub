import { ACTIVE_MEMBER, FROM_ACTIVE_ITEMS } from "./db/scopes.ts";
import type { SqlDatabase } from "./db/types.ts";

export const MAX_QUERY_LENGTH = 50;
const MAX_ROWS = 2_000;

export interface Holding {
  ownerId: string;
  ownerKind: string;
  ownerName: string | null;
  /** The member/character whose upload this data came from. For retainers that's the owner. */
  member: string;
  character: string;
  homeWorld: string | null;
  quantity: number;
  locations: { location: string; quantity: number }[];
  /** When this section was last captured in game. */
  updatedAt: string;
}

export interface SearchHit {
  itemId: number;
  name: string;
  iconId: number;
  isHq: boolean;
  totalQuantity: number;
  holdings: Holding[];
}

interface Row {
  item_id: number;
  name: string;
  icon_id: number;
  is_hq: number;
  quantity: number;
  location: string;
  owner_id: string;
  owner_kind: string;
  owner_name: string | null;
  captured_at: string;
  character_name: string;
  home_world: string | null;
  member_name: string;
}

/**
 * Finds items by case-insensitive name substring (or exact item id when the query is numeric),
 * grouped as item (+HQ) → owner → slot locations.
 */
export async function searchItems(db: SqlDatabase, query: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { hits: [], truncated: false };

  const byId = /^\d+$/.test(q);
  const rows = await db
    .prepare(
      `SELECT i.item_id, i.name, i.icon_id, i.is_hq, i.quantity, i.location,
              o.owner_id, o.kind AS owner_kind, o.name AS owner_name,
              s.captured_at, c.name AS character_name, c.home_world, m.display_name AS member_name
       ${FROM_ACTIVE_ITEMS}
       WHERE ${byId ? "i.item_id = ?1" : "instr(lower(i.name), ?1) > 0"}
       ORDER BY i.name, i.is_hq DESC, i.item_id, o.kind, o.name, i.sorted_container, i.sorted_slot
       LIMIT ${MAX_ROWS + 1}`,
    )
    .bind(byId ? Number(q) : q)
    .all<Row>();

  const truncated = rows.results.length > MAX_ROWS;
  const hits = new Map<string, SearchHit>();
  for (const row of rows.results.slice(0, MAX_ROWS)) {
    const key = `${row.item_id}:${row.is_hq}`;
    let hit = hits.get(key);
    if (!hit) {
      hit = { itemId: row.item_id, name: row.name, iconId: row.icon_id, isHq: row.is_hq === 1, totalQuantity: 0, holdings: [] };
      hits.set(key, hit);
    }
    hit.totalQuantity += row.quantity;

    let holding = hit.holdings.find((h) => h.ownerId === row.owner_id);
    if (!holding) {
      holding = {
        ownerId: row.owner_id,
        ownerKind: row.owner_kind,
        ownerName: row.owner_name,
        member: row.member_name,
        character: row.character_name,
        homeWorld: row.home_world,
        quantity: 0,
        locations: [],
        updatedAt: row.captured_at,
      };
      hit.holdings.push(holding);
    }
    holding.quantity += row.quantity;
    holding.locations.push({ location: row.location, quantity: row.quantity });
    if (row.captured_at < holding.updatedAt) holding.updatedAt = row.captured_at;
  }

  return { hits: [...hits.values()], truncated };
}

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
        `SELECT s.section, s.item_count, s.captured_at, c.name AS character_name, m.display_name AS member_name
         FROM owner_sections s
         JOIN characters c ON c.content_id = s.reported_by
         JOIN members m ON m.id = c.member_id
         WHERE s.owner_id = ? AND ${ACTIVE_MEMBER}`,
      )
      .bind(ownerId)
      .all<{ section: string; item_count: number; captured_at: string; character_name: string; member_name: string }>(),
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
