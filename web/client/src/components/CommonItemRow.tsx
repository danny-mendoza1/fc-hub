import type { CommonItem } from "../../../src/api-types.ts";
import { numberFormat, placeTitle, placeWhere } from "../format.ts";
import { HqBadge } from "./Bits.tsx";
import styles from "./CommonItemRow.module.css";
import { ItemIcon } from "./ItemIcon.tsx";

export function CommonItemRow({ item }: { item: CommonItem }) {
  const name = item.name || `Item #${item.itemId}`;
  return (
    <li className={styles.card}>
      <details>
        <summary className={styles.summary}>
          <ItemIcon iconId={item.iconId} size="large" />
          <span className={styles.identity}>
            <span className={styles.name} title={name}>
              {name}
            </span>
            <span className={styles.meta}>
              {item.isHq && <HqBadge />} {item.holders.length} holders
            </span>
          </span>
          <span className={styles.total}>
            <strong>{numberFormat.format(item.totalQuantity)}</strong> total
          </span>
          <span aria-hidden="true" className={styles.chevron}>
            ›
          </span>
        </summary>
        <div className={styles.breakdown}>
          <strong>{name}</strong> <span className={styles.meta}>#{item.itemId}</span>
          <ul className={styles.holders}>
            {item.holders.map((holder) => (
              <li key={holder.key}>
                <span className={styles.label}>
                  {holder.label} <b>{numberFormat.format(holder.quantity)}</b>
                </span>
                {holder.places.map((place) => (
                  <span className={styles.place} key={`${place.ownerId}:${place.section}`} title={placeTitle(place)}>
                    {placeWhere(place)}
                    {holder.places.length > 1 && ` · ${numberFormat.format(place.quantity)}`}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}
