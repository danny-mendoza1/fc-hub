/**
 * Where else an item is stored, and which items several holders have in common, to help the FC
 * consolidate storage.
 *
 * Browser-safe (no Node or DB imports): the React client imports `commonItems` and the types,
 * so the server and the UI share one tested implementation (as with Wondrous Tails).
 */

/**
 * Sections whose items sit in storage and could be moved to another place. Left out: gear that's
 * equipped, market listings, glamour dresser/armoire, placed furnishings, gil/currencies and
 * crystals (everyone holds every crystal, so they'd drown out everything else).
 */
export const STORAGE_SECTIONS: readonly string[] = [
  "CharacterBags",
  "CharacterSaddleBags",
  "CharacterPremiumSaddleBags",
  "CharacterArmoryChest",
  "RetainerBags",
  "FreeCompanyBags",
  "HousingInteriorStoreroom",
  "HousingExteriorStoreroom",
];

/**
 * Sections behind the plugin's item tooltips (other members' holdings): storage plus crystals.
 * Crafters hover a crystal to see who has spares, so crystals count here even though "in common"
 * leaves them out.
 */
export const TOOLTIP_SECTIONS: readonly string[] = [...STORAGE_SECTIONS, "Crystals"];

/** One item (+HQ) in one section of one owner, all stacks added up. */
export interface ItemPlace {
  ownerId: string;
  ownerKind: string;
  ownerName: string | null;
  section: string;
  /** The member/character whose upload this section came from (for retainers, their owner). */
  memberId: number;
  member: string;
  character: string;
  quantity: number;
  stacks: number;
  /** When this section was last captured in game. */
  updatedAt: string;
}

export interface PlacedItem {
  itemId: number;
  name: string;
  iconId: number;
  isHq: boolean;
  places: ItemPlace[];
}

/**
 * Who can hold an item, for "in common": each member (all of their characters and retainers
 * together), plus each shared storage (the FC chest, a house), which isn't any one member's.
 */
export interface ItemHolder {
  key: string;
  label: string;
  kind: "member" | "shared";
}

/** Every storage place of each item an owner holds, as the client uses it (see `expandPlaces`). */
export interface AlsoInResponse {
  /** Includes this owner's own storage places; see `otherPlaces`. */
  items: PlacedItem[];
}

/** "Items in common", as the client uses it (see `expandPlaces`). */
export interface ItemsInCommonResponse {
  holders: ItemHolder[];
  /** Items with two or more holders across everyone; the browser narrows this to the chosen party. */
  items: PlacedItem[];
}

/** One section of one owner that items sit in: everything about an {@link ItemPlace} but the amounts. */
export type PlaceSection = Omit<ItemPlace, "quantity" | "stacks">;

/** A place on the wire: `[index into sections, quantity, stacks]`. */
export type PlaceRef = [section: number, quantity: number, stacks: number];

/**
 * Places in compact form. Thousands of places share a few dozen sections, so each section's
 * owner, member, character and capture time is sent once rather than on every place (a full FC's
 * "in common" went from ~2.9 MB of JSON to a fraction of that). `expandPlaces` rebuilds the full shape.
 */
export interface PlacesWire {
  sections: PlaceSection[];
  items: (Omit<PlacedItem, "places"> & { places: PlaceRef[] })[];
}

/** GET /api/v1/owners/:ownerId/also-in */
export type AlsoInWire = PlacesWire;

/** GET /api/v1/items/in-common */
export type ItemsInCommonWire = PlacesWire & { holders: ItemHolder[] };

/** GET /api/v1/items/fc-holdings: the other members' storage, for the plugin's item tooltips. */
export type FcHoldingsWire = PlacesWire;

/** Packs places for the wire (the server side of {@link expandPlaces}). */
export function compactPlaces(items: PlacedItem[]): PlacesWire {
  const sections: PlaceSection[] = [];
  const index = new Map<string, number>();
  const packed = items.map(({ places, ...item }) => ({
    ...item,
    places: places.map(({ quantity, stacks, ...section }): PlaceRef => {
      const key = `${section.ownerId}\u0000${section.section}`;
      let i = index.get(key);
      if (i === undefined) {
        i = sections.length;
        index.set(key, i);
        sections.push(section);
      }
      return [i, quantity, stacks];
    }),
  }));
  return { sections, items: packed };
}

/** Rebuilds full places from the wire form (the client side of {@link compactPlaces}). */
export function expandPlaces(wire: PlacesWire): PlacedItem[] {
  return wire.items.map(({ places, ...item }) => ({
    ...item,
    places: places.map(([section, quantity, stacks]) => {
      const where = wire.sections[section];
      if (!where) throw new Error(`Place refers to unknown section ${section}`);
      return { ...where, quantity, stacks };
    }),
  }));
}

export interface CommonItem {
  itemId: number;
  name: string;
  iconId: number;
  isHq: boolean;
  totalQuantity: number;
  holders: { key: string; label: string; quantity: number; places: ItemPlace[] }[];
}

export function isSharedStorage(ownerKind: string): boolean {
  return ownerKind === "freeCompany" || ownerKind === "housing";
}

export function holderKey(place: Pick<ItemPlace, "ownerKind" | "ownerId" | "memberId">): string {
  return isSharedStorage(place.ownerKind) ? `owner:${place.ownerId}` : `member:${place.memberId}`;
}

export function holderLabel(place: Pick<ItemPlace, "ownerKind" | "ownerName" | "member">): string {
  if (place.ownerKind === "freeCompany") return "FC chest";
  if (place.ownerKind === "housing") return place.ownerName ?? "House";
  return place.member;
}

/** Item (+HQ) identity: NQ and HQ don't stack, so they're different items here. */
export function itemKey(item: { itemId: number; isHq: boolean }): string {
  return `${item.itemId}:${item.isHq ? 1 : 0}`;
}

/** Every holder that appears in `items`: members by name, then shared storage. */
export function holdersOf(items: PlacedItem[]): ItemHolder[] {
  const holders = new Map<string, ItemHolder>();
  for (const item of items) {
    for (const place of item.places) {
      const key = holderKey(place);
      if (!holders.has(key))
        holders.set(key, { key, label: holderLabel(place), kind: isSharedStorage(place.ownerKind) ? "shared" : "member" });
    }
  }
  return [...holders.values()].sort((a, b) => Number(a.kind === "shared") - Number(b.kind === "shared") || a.label.localeCompare(b.label));
}

/**
 * Items that two or more of the selected holders have, with where each holds it. Sorted by how
 * many of them hold it, then by name, so the best candidates for consolidating come first.
 */
export function commonItems(items: PlacedItem[], selectedHolders: ReadonlySet<string>): CommonItem[] {
  const result: CommonItem[] = [];
  for (const item of items) {
    const byHolder = new Map<string, CommonItem["holders"][number]>();
    for (const place of item.places) {
      const key = holderKey(place);
      if (!selectedHolders.has(key)) continue;
      let holder = byHolder.get(key);
      if (!holder) {
        holder = { key, label: holderLabel(place), quantity: 0, places: [] };
        byHolder.set(key, holder);
      }
      holder.quantity += place.quantity;
      holder.places.push(place);
    }
    if (byHolder.size < 2) continue;
    const holders = [...byHolder.values()].sort((a, b) => b.quantity - a.quantity || a.label.localeCompare(b.label));
    result.push({
      itemId: item.itemId,
      name: item.name,
      iconId: item.iconId,
      isHq: item.isHq,
      totalQuantity: holders.reduce((sum, h) => sum + h.quantity, 0),
      holders,
    });
  }
  return result.sort((a, b) => b.holders.length - a.holders.length || a.name.localeCompare(b.name) || Number(a.isHq) - Number(b.isHq));
}

/** The item's other places, leaving out the section being looked at. */
export function otherPlaces(places: ItemPlace[], ownerId: string, section: string): ItemPlace[] {
  return places.filter((p) => !(p.ownerId === ownerId && p.section === section));
}
