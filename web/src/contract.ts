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
import { type Validation, Validator } from "./validation.ts";

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

/** The upload-shape limits from limits.ts (overridable there, not here). */
export type UploadLimits = Pick<Limits, "ownersPerUpload" | "sectionsPerOwner" | "itemsPerSection" | "itemsPerUpload">;

/** Strict structural validation; unknown fields are ignored, wrong types are errors. */
export function validateUpload(input: unknown, limits: UploadLimits = DEFAULT_LIMITS): Validation<Upload> {
  const v = new Validator();
  const errors = v.errors;

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
    const kind = v.oneOf(owner.kind, `${path}.kind`, OWNER_KINDS);

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
  if (totalItems > limits.itemsPerUpload)
    errors.push(`owners hold ${totalItems} items in total; at most ${limits.itemsPerUpload} per upload`);

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
