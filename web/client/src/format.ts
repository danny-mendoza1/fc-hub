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
