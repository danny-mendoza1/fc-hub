import { FROM_ACTIVE_ITEMS } from "./db/scopes.ts";
import type { SqlDatabase } from "./db/types.ts";
import {
  type AlsoInWire,
  compactPlaces,
  type FcHoldingsWire,
  holderKey,
  holdersOf,
  type ItemsInCommonWire,
  itemKey,
  type PlacedItem,
  STORAGE_SECTIONS,
  TOOLTIP_SECTIONS,
} from "./item-overlap.ts";

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

/** A constant section list (never user input) as SQL, so it's inlined rather than bound. */
function sqlList(sections: readonly string[]): string {
  return sections.map((s) => `'${s}'`).join(", ");
}

/** Item (+HQ) × owner × section totals in the given sections, optionally limited further. */
function placesQuery(sections: readonly string[], filter: string): string {
  return `SELECT i.item_id, MAX(i.name) AS name, MAX(i.icon_id) AS icon_id, i.is_hq,
                 i.owner_id, o.kind AS owner_kind, o.name AS owner_name, i.section,
                 SUM(i.quantity) AS quantity, COUNT(*) AS stacks,
                 s.captured_at, c.name AS character_name, m.id AS member_id, m.display_name AS member_name
          ${FROM_ACTIVE_ITEMS}
          WHERE i.section IN (${sqlList(sections)}) ${filter}
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
export async function alsoIn(db: SqlDatabase, ownerId: string): Promise<AlsoInWire> {
  const rows = await db
    .prepare(placesQuery(STORAGE_SECTIONS, "AND (i.item_id, i.is_hq) IN (SELECT item_id, is_hq FROM items WHERE owner_id = ?1)"))
    .bind(ownerId)
    .all<PlaceRow>();
  // The owner's own storage comes back too: the browser leaves out the section being viewed, and an
  // equipped item's only other place may be this same character's armoury chest.
  return compactPlaces(group(rows.results));
}

/** For "Items in common": items that two or more holders (members, FC chest, houses) store. */
export async function itemsInCommon(db: SqlDatabase): Promise<ItemsInCommonWire> {
  const rows = await db.prepare(placesQuery(STORAGE_SECTIONS, "")).all<PlaceRow>();
  const all = group(rows.results);
  return {
    holders: holdersOf(all),
    ...compactPlaces(all.filter((item) => new Set(item.places.map(holderKey)).size >= 2)),
  };
}

/**
 * For the plugin's item tooltips: every other member's storage and crystals. The caller's own
 * characters and the shared FC chest / houses are left out, because Allagan Tools already shows
 * them in the same tooltip.
 */
export async function fcHoldings(db: SqlDatabase, memberId: number): Promise<FcHoldingsWire> {
  const rows = await db
    .prepare(placesQuery(TOOLTIP_SECTIONS, "AND m.id != ?1 AND o.kind NOT IN ('freeCompany', 'housing')"))
    .bind(memberId)
    .all<PlaceRow>();
  return compactPlaces(group(rows.results));
}
