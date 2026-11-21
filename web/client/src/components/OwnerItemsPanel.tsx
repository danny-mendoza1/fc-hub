import { useMemo } from "react";
import type { ItemPlace, OwnerItem } from "../../../src/api-types.ts";
import { isSharedStorage, itemKey, otherPlaces } from "../../../src/item-overlap.ts";
import { bySectionOrder, numberFormat, placeTitle, placeWhere, SECTION_LABELS } from "../format.ts";
import { useApi } from "../hooks.ts";
import { queries } from "../queries.ts";
import { Accordion } from "./Accordion.tsx";
import { Age, HqBadge } from "./Bits.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import styles from "./OwnerItemsPanel.module.css";
import ui from "./ui.module.css";

/** Item (+HQ) → every storage place it's in, this owner's included. */
type PlacesByItem = ReadonlyMap<string, ItemPlace[]>;

const NO_PLACES: PlacesByItem = new Map();

/** Loads one owner's items (on first expand) and shows a nested accordion per section. */
export function OwnerItemsPanel({ ownerId }: { ownerId: string }) {
  const state = useApi(queries.ownerItems(ownerId), { errorPrefix: "Couldn't load items" });
  // "Also in" is extra: if it fails, the items still show, just without it.
  const alsoIn = useApi(queries.alsoIn(ownerId));
  const places = useMemo(
    () => (alsoIn.status === "done" ? new Map(alsoIn.data.items.map((i) => [itemKey(i), i.places])) : NO_PLACES),
    [alsoIn],
  );

  if (state.status === "loading") return <p className={ui.muted}>Loading items…</p>;
  if (state.status === "error") return <p className={ui.error}>{state.message}</p>;

  const sections = [...state.data.sections].sort(bySectionOrder);
  if (sections.length === 0) return <p className={ui.muted}>Nothing uploaded for this one yet.</p>;

  return (
    <div>
      {sections.map((section) => (
        <Accordion
          key={section.section}
          level="section"
          // A lone section (e.g. the FC chest) has nothing to choose between, so open it straight away.
          defaultOpen={sections.length === 1}
          summary={
            <div className={styles.sectionSummary}>
              <span className={styles.sectionName}>{SECTION_LABELS[section.section] ?? section.section}</span>
              <span className={ui.muted}>
                {numberFormat.format(section.itemCount)} item{section.itemCount === 1 ? "" : "s"}
              </span>
              <span className={styles.sectionMeta}>
                {/* A shared section someone saw in game says so; otherwise the time is just when it was reported (ADR 0008). */}
                {section.observedAt ? (
                  <>
                    seen in game <Age iso={section.observedAt} />
                  </>
                ) : (
                  <Age iso={section.capturedAt} />
                )}
              </span>
            </div>
          }
        >
          {() => <ItemList items={section.items} ownerId={ownerId} section={section.section} places={places} />}
        </Accordion>
      ))}
    </div>
  );
}

interface ItemListProps {
  items: OwnerItem[];
  ownerId: string;
  section: string;
  places: PlacesByItem;
}

function ItemList({ items, ownerId, section, places }: ItemListProps) {
  if (items.length === 0) return <p className={ui.muted}>Empty.</p>;
  return (
    <ul className={styles.items}>
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list from one response; the index only breaks ties between same-slot rows.
        <li key={`${item.sortedContainer}:${item.sortedSlot}:${index}`} className={styles.item}>
          <ItemIcon iconId={item.iconId} />
          <span className={styles.itemName}>
            {item.name || `Item #${item.itemId}`}
            {item.isHq && <HqBadge />}
          </span>
          <span className={styles.qty}>{numberFormat.format(item.quantity)}</span>
          <span className={styles.location}>{item.location}</span>
          <AlsoIn places={otherPlaces(places.get(itemKey(item)) ?? [], ownerId, section)} />
        </li>
      ))}
    </ul>
  );
}

/** "Also in: FC chest 999 · Bob · Saddlebag 7": the item's other storage places, for consolidating. */
function AlsoIn({ places }: { places: ItemPlace[] }) {
  if (places.length === 0) return null;
  return (
    <div className={styles.alsoIn}>
      <span className={styles.alsoInLabel}>Also in</span>
      {places.map((p) => (
        <span key={`${p.ownerId}:${p.section}`} className={styles.place} title={placeTitle(p)}>
          {!isSharedStorage(p.ownerKind) && <span className={styles.placeMember}>{p.member} · </span>}
          {placeWhere(p)} <span className={styles.placeQty}>{numberFormat.format(p.quantity)}</span>
        </span>
      ))}
    </div>
  );
}
