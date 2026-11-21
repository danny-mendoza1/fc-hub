import type { ItemPlace } from "../../src/api-types.ts";

export const numberFormat = new Intl.NumberFormat();

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday", "just now". */
export function ago(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Data older than this is highlighted, since it may no longer match the game. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const KIND_LABELS: Record<string, string> = {
  character: "Character",
  retainer: "Retainer",
  freeCompany: "FC chest",
  housing: "House",
  unknown: "Other",
};

export const SECTION_LABELS: Record<string, string> = {
  CharacterBags: "Inventory",
  CharacterSaddleBags: "Saddlebag",
  CharacterPremiumSaddleBags: "Premium saddlebag",
  CharacterArmoryChest: "Armoury chest",
  CharacterEquipped: "Equipped",
  RetainerBags: "Retainer bags",
  RetainerEquipped: "Retainer gear",
  RetainerMarket: "Market listings",
  FreeCompanyBags: "FC chest",
  GlamourChest: "Glamour dresser",
  Armoire: "Armoire",
  Currency: "Currency",
  Crystals: "Crystals",
  HousingInteriorItems: "Interior furnishings",
  HousingInteriorStoreroom: "Interior storeroom",
  HousingInteriorAppearance: "Interior fixtures",
  HousingExteriorItems: "Exterior furnishings",
  HousingExteriorStoreroom: "Exterior storeroom",
  HousingExteriorAppearance: "Exterior fixtures",
};

/**
 * Roughly the order the game presents them in, so the accordions feel familiar: bags first,
 * then gear and listings, with gil/crystals last (they're single lines, not something you browse).
 */
const SECTION_ORDER = [
  "CharacterEquipped",
  "CharacterBags",
  "CharacterArmoryChest",
  "CharacterSaddleBags",
  "CharacterPremiumSaddleBags",
  "RetainerBags",
  "RetainerMarket",
  "RetainerEquipped",
  "FreeCompanyBags",
  "Crystals",
  "Currency",
  "Armoire",
  "GlamourChest",
  "HousingInteriorItems",
  "HousingInteriorStoreroom",
  "HousingInteriorAppearance",
  "HousingExteriorItems",
  "HousingExteriorStoreroom",
  "HousingExteriorAppearance",
];

export function bySectionOrder(a: { section: string }, b: { section: string }): number {
  const rank = (s: string) => {
    const i = SECTION_ORDER.indexOf(s);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  return rank(a.section) - rank(b.section) || a.section.localeCompare(b.section);
}

/** Where in someone's storage an item is: "Saddlebag", "Sir-noodle (retainer)", "FC chest". */
export function placeWhere(place: ItemPlace): string {
  const section = SECTION_LABELS[place.section] ?? place.section;
  if (place.ownerKind === "freeCompany") return "FC chest";
  if (place.ownerKind === "retainer") return `${place.ownerName ?? "Retainer"} (retainer)`;
  if (place.ownerKind === "housing") return `${place.ownerName ?? "House"} ${section.toLowerCase()}`;
  return section;
}

/** Tooltip detail: whose it is, stacks, and when it was captured. */
export function placeTitle(place: ItemPlace): string {
  const whose =
    place.ownerKind === "retainer" ? `${place.character}'s retainer ${place.ownerName ?? ""}`.trim()
    : place.ownerKind === "character" ? `${place.character}'s ${(SECTION_LABELS[place.section] ?? place.section).toLowerCase()}`
    : placeWhere(place);
  const stacks = place.stacks > 1 ? ` in ${place.stacks} stacks` : "";
  return `${whose}: ${numberFormat.format(place.quantity)}${stacks}, as of ${ago(place.updatedAt)}`;
}
