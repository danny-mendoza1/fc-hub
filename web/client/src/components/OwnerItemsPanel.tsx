import { useEffect, useState } from "react";
import type { OwnerItem, OwnerItems } from "../../../src/api-types.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import { bySectionOrder, numberFormat, SECTION_LABELS } from "../format.ts";
import { Accordion } from "./Accordion.tsx";
import { Age, HqBadge } from "./Bits.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import ui from "./ui.module.css";
import styles from "./OwnerItemsPanel.module.css";

type State = { status: "loading" } | { status: "done"; data: OwnerItems } | { status: "error"; message: string };

/** Loads one owner's items (on first expand) and shows a nested accordion per section. */
export function OwnerItemsPanel({ ownerId, onUnauthorized }: { ownerId: string; onUnauthorized: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .ownerItems(ownerId)
      .then((data) => !cancelled && setState({ status: "done", data }))
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof Unauthorized) return onUnauthorized();
        setState({ status: "error", message: `Couldn't load items: ${errorMessage(error)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, onUnauthorized]);

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
                <Age iso={section.capturedAt} />
              </span>
            </div>
          }
        >
          {() => <ItemList items={section.items} />}
        </Accordion>
      ))}
    </div>
  );
}

function ItemList({ items }: { items: OwnerItem[] }) {
  if (items.length === 0) return <p className={ui.muted}>Empty.</p>;
  return (
    <ul className={styles.items}>
      {items.map((item, index) => (
        <li key={`${item.sortedContainer}:${item.sortedSlot}:${index}`} className={styles.item}>
          <ItemIcon iconId={item.iconId} />
          <span className={styles.itemName}>
            {item.name || `Item #${item.itemId}`}
            {item.isHq && <HqBadge />}
          </span>
          <span className={styles.qty}>{numberFormat.format(item.quantity)}</span>
          <span className={styles.location}>{item.location}</span>
        </li>
      ))}
    </ul>
  );
}
