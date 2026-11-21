/**
 * Upload contract between the plugin and the server (schema v2).
 *
 * The plugin sends only the sections that changed since its last successful upload.
 * Each section it does send fully replaces that (owner, section) on the server; an empty
 * `items` array means the section is now empty. Sections and owners that aren't sent are
 * left untouched. Retainers the plugin can't see this session therefore keep their
 * last-known contents.
 */
import { DEFAULT_LIMITS, type Limits } from "./limits.ts";

export const SCHEMA_VERSION = 2;

export const OWNER_KINDS = ["character", "retainer", "freeCompany", "housing", "unknown"] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

export interface UploadItem {
  itemId: number;
  name: string;
  iconId: number;
  quantity: number;
  isHq: boolean;
  isCollectable: boolean;
  container: number;
  sortedContainer: number;
  sortedSlot: number;
  location: string;
}

export interface UploadSection {
  section: string;
  items: UploadItem[];
}

export interface UploadOwner {
  ownerId: string;
  kind: OwnerKind;
  name: string | null;
  sections: UploadSection[];
}

export interface Upload {
  schemaVersion: number;
  pluginVersion: string;
  capturedAt: string;
  character: {
    contentId: string;
    name: string;
    homeWorldId: number;
    homeWorld: string | null;
  };
  owners: UploadOwner[];
}

/** Max length of any text field (names, locations). */
export const TEXT_MAX = 200;

/** The upload-shape limits from limits.ts (overridable there, not here). */
export type UploadLimits = Pick<Limits, "ownersPerUpload" | "sectionsPerOwner" | "itemsPerSection" | "itemsPerUpload">;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Strict structural validation; unknown fields are ignored, wrong types are errors. */
export function validateUpload(input: unknown, limits: UploadLimits = DEFAULT_LIMITS): Validation<Upload> {
  const errors: string[] = [];
  const v = new Validator(errors);

  const root = v.object(input, "body");
  if (!root) return { ok: false, errors };

  const schemaVersion = v.int(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== undefined && schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }

  const capturedAt = v.text(root.capturedAt, "capturedAt");
  if (capturedAt !== undefined && Number.isNaN(Date.parse(capturedAt))) errors.push("capturedAt must be an ISO timestamp");

  const characterIn = v.object(root.character, "character");
  const character = characterIn && {
    contentId: v.id(characterIn.contentId, "character.contentId"),
    name: v.text(characterIn.name, "character.name"),
    homeWorldId: v.int(characterIn.homeWorldId, "character.homeWorldId"),
    homeWorld: v.optionalText(characterIn.homeWorld, "character.homeWorld"),
  };

  const owners = v.array(root.owners, "owners", limits.ownersPerUpload)?.map((ownerIn, o) => {
    const path = `owners[${o}]`;
    const owner = v.object(ownerIn, path);
    if (!owner) return undefined;
    const kind = v.text(owner.kind, `${path}.kind`);
    if (kind !== undefined && !(OWNER_KINDS as readonly string[]).includes(kind)) errors.push(`${path}.kind is invalid`);

    const sections = v.array(owner.sections, `${path}.sections`, limits.sectionsPerOwner)?.map((sectionIn, s) => {
      const spath = `${path}.sections[${s}]`;
      const section = v.object(sectionIn, spath);
      if (!section) return undefined;
      const items = v.array(section.items, `${spath}.items`, limits.itemsPerSection)?.map((itemIn, i) => {
        const ipath = `${spath}.items[${i}]`;
        const item = v.object(itemIn, ipath);
        if (!item) return undefined;
        return {
          itemId: v.int(item.itemId, `${ipath}.itemId`),
          name: v.text(item.name, `${ipath}.name`, true),
          iconId: v.int(item.iconId, `${ipath}.iconId`),
          quantity: v.int(item.quantity, `${ipath}.quantity`),
          isHq: v.bool(item.isHq, `${ipath}.isHq`),
          isCollectable: v.bool(item.isCollectable, `${ipath}.isCollectable`),
          container: v.int(item.container, `${ipath}.container`),
          sortedContainer: v.int(item.sortedContainer, `${ipath}.sortedContainer`),
          sortedSlot: v.int(item.sortedSlot, `${ipath}.sortedSlot`),
          location: v.text(item.location, `${ipath}.location`),
        };
      });
      return { section: v.text(section.section, `${spath}.section`), items };
    });

    const names = sections?.map((s) => s?.section);
    if (names && new Set(names).size !== names.length) errors.push(`${path}.sections has duplicate section names`);

    return {
      ownerId: v.id(owner.ownerId, `${path}.ownerId`),
      kind,
      name: v.optionalText(owner.name, `${path}.name`),
      sections,
    };
  });

  const totalItems = owners?.reduce((sum, o) => sum + (o?.sections?.reduce((n, sec) => n + (sec?.items?.length ?? 0), 0) ?? 0), 0) ?? 0;
  if (totalItems > limits.itemsPerUpload) errors.push(`owners hold ${totalItems} items in total; at most ${limits.itemsPerUpload} per upload`);

  const ownerIds = owners?.map((o) => o?.ownerId);
  if (ownerIds && new Set(ownerIds).size !== ownerIds.length) errors.push("owners has duplicate ownerIds");

  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 20) };

  return {
    ok: true,
    value: {
      schemaVersion: schemaVersion!,
      pluginVersion: v.text(root.pluginVersion, "pluginVersion") ?? "",
      capturedAt: capturedAt!,
      character: character as Upload["character"],
      owners: owners as UploadOwner[],
    },
  };
}

class Validator {
  private readonly errors: string[];

  constructor(errors: string[]) {
    this.errors = errors;
  }

  object(value: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    this.errors.push(`${path} must be an object`);
    return undefined;
  }

  array(value: unknown, path: string, max: number): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.errors.push(`${path} must be an array`);
      return undefined;
    }
    if (value.length > max) {
      this.errors.push(`${path} has more than ${max} entries`);
      return undefined;
    }
    return value;
  }

  text(value: unknown, path: string, allowEmpty = false): string | undefined {
    if (typeof value === "string" && value.length <= TEXT_MAX && (allowEmpty || value.length > 0)) return value;
    this.errors.push(`${path} must be a ${allowEmpty ? "" : "non-empty "}string of at most ${TEXT_MAX} characters`);
    return undefined;
  }

  optionalText(value: unknown, path: string): string | null | undefined {
    if (value === null || value === undefined) return null;
    return this.text(value, path, true);
  }

  int(value: unknown, path: string): number | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    this.errors.push(`${path} must be a non-negative integer`);
    return undefined;
  }

  bool(value: unknown, path: string): boolean | undefined {
    if (typeof value === "boolean") return value;
    this.errors.push(`${path} must be a boolean`);
    return undefined;
  }

  /** 64-bit game ids travel as decimal strings (they exceed JS's safe integer range). */
  id(value: unknown, path: string): string | undefined {
    if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)) return value;
    this.errors.push(`${path} must be a decimal id string`);
    return undefined;
  }
}
