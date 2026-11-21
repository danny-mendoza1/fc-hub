import type { CommonItem } from "../../../src/api-types.ts";
import { numberFormat, placeTitle, placeWhere } from "../format.ts";
import { HqBadge } from "./Bits.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import styles from "./CommonItemRow.module.css";
import ui from "./ui.module.css";

export function CommonItemRow({ item }: { item: CommonItem }) {
  return (
    <li className={`${ui.rankedRow} ${styles.row}`}>
      <ItemIcon iconId={item.iconId} size="large" />
      <div className={ui.rankedBody}>
        <div className={styles.name}>
          {item.name || `Item #${item.itemId}`}
          {item.isHq && <HqBadge />}
          <span className={styles.total}>{numberFormat.format(item.totalQuantity)} total</span>
        </div>
        <ul className={styles.holders}>
          {item.holders.map((h) => (
            <li key={h.key}>
              <span className={styles.holder}>{h.label}</span> <span className={styles.qty}>{numberFormat.format(h.quantity)}</span>
              {/* Shared storage is its own place; for members, say where (inventory, which retainer…). */}
              {!(h.places.length === 1 && h.places[0]!.ownerKind === "freeCompany") && (
                <span className={ui.muted}>
                  {" "}
                  (
                  {h.places.map((p, i) => (
                    <span key={`${p.ownerId}:${p.section}`} title={placeTitle(p)}>
                      {i > 0 && ", "}
                      {placeWhere(p)}
                      {h.places.length > 1 && ` ${numberFormat.format(p.quantity)}`}
                    </span>
                  ))}
                  )
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <span className={`${ui.countPill} ${styles.count}`} title={`Stored by ${item.holders.length} of the selection`}>
        {item.holders.length}
      </span>
    </li>
  );
}
