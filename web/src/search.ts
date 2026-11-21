import { FROM_ACTIVE_ITEMS } from "./db/scopes.ts";
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
