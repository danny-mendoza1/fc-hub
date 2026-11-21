import type { SqlDatabase } from "./db/types.ts";
import { type AlsoInResponse, holderKey, holdersOf, type ItemsInCommonResponse, itemKey, type PlacedItem, STORAGE_SECTIONS } from "./item-overlap.ts";

interface PlaceRow {
  item_id: number;
  name: string;
  icon_id: number;
  is_hq: number;
  owner_id: string;
  owner_kind: string;
  owner_name: string | null;
  section: string;
  quantity: number;
  stacks: number;
  captured_at: string;
  character_name: string;
  member_id: number;
  member_name: string;
}

// Constant list (not user input), so it's inlined rather than bound.
const STORAGE_SQL = STORAGE_SECTIONS.map((s) => `'${s}'`).join(", ");

/** Item (+HQ) × owner × section totals in storage sections, optionally limited further. */
function placesQuery(filter: string): string {
  return `SELECT i.item_id, MAX(i.name) AS name, MAX(i.icon_id) AS icon_id, i.is_hq,
                 i.owner_id, o.kind AS owner_kind, o.name AS owner_name, i.section,
                 SUM(i.quantity) AS quantity, COUNT(*) AS stacks,
                 s.captured_at, c.name AS character_name, m.id AS member_id, m.display_name AS member_name
          FROM items i
          JOIN owner_sections s ON s.owner_id = i.owner_id AND s.section = i.section
          JOIN owners o ON o.owner_id = i.owner_id
          JOIN characters c ON c.content_id = s.reported_by
          JOIN members m ON m.id = c.member_id
          WHERE m.revoked_at IS NULL AND i.section IN (${STORAGE_SQL}) ${filter}
          GROUP BY i.item_id, i.is_hq, i.owner_id, i.section
          ORDER BY name, i.is_hq, member_name, o.kind, o.name, i.section`;
}

function group(rows: PlaceRow[]): PlacedItem[] {
  const items = new Map<string, PlacedItem>();
  for (const row of rows) {
    const key = itemKey({ itemId: row.item_id, isHq: row.is_hq === 1 });
    let item = items.get(key);
    if (!item) {
      item = { itemId: row.item_id, name: row.name, iconId: row.icon_id, isHq: row.is_hq === 1, places: [] };
      items.set(key, item);
    }
    item.places.push({
      ownerId: row.owner_id,
      ownerKind: row.owner_kind,
      ownerName: row.owner_name,
      section: row.section,
      memberId: row.member_id,
      member: row.member_name,
      character: row.character_name,
      quantity: row.quantity,
      stacks: row.stacks,
      updatedAt: row.captured_at,
    });
  }
  return [...items.values()];
}

/** For the item drill-down: every storage place of the items (+HQ) this owner holds, in any section. */
export async function alsoIn(db: SqlDatabase, ownerId: string): Promise<AlsoInResponse> {
  const rows = await db
    .prepare(placesQuery("AND (i.item_id, i.is_hq) IN (SELECT item_id, is_hq FROM items WHERE owner_id = ?1)"))
    .bind(ownerId)
    .all<PlaceRow>();
  // The owner's own storage comes back too: the browser leaves out the section being viewed, and an
  // equipped item's only other place may be this same character's armoury chest.
  return { items: group(rows.results) };
}

/** For "Items in common": items that two or more holders (members, FC chest, houses) store. */
export async function itemsInCommon(db: SqlDatabase): Promise<ItemsInCommonResponse> {
  const rows = await db.prepare(placesQuery("")).all<PlaceRow>();
  const all = group(rows.results);
  return {
    holders: holdersOf(all),
    items: all.filter((item) => new Set(item.places.map(holderKey)).size >= 2),
  };
}
