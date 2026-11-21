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

/** GET /api/v1/owners/:ownerId/also-in: every storage place of each item this owner holds. */
export interface AlsoInResponse {
  /** Includes this owner's own storage places; see `otherPlaces`. */
  items: PlacedItem[];
}

/** GET /api/v1/items/in-common */
export interface ItemsInCommonResponse {
  holders: ItemHolder[];
  /** Items with two or more holders across everyone; the browser narrows this to the chosen party. */
  items: PlacedItem[];
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
