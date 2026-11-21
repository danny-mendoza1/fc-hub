import type { CommonItem } from "../../../src/api-types.ts";
import { numberFormat, placeTitle, placeWhere } from "../format.ts";
import { HqBadge } from "./Bits.tsx";
import styles from "./CommonItemRow.module.css";
import { ItemIcon } from "./ItemIcon.tsx";

export function CommonItemRow({ item }: { item: CommonItem }) {
  const name = item.name || `Item #${item.itemId}`;
  const preview = item.holders.slice(0, 2);
  const remaining = item.holders.length - preview.length;
  return (
    <li className={styles.card}>
      <details>
        <summary className={styles.summary}>
          <ItemIcon iconId={item.iconId} size="large" />
          <span className={styles.identity}>
            <span className={styles.name} title={name}>
              {name}
            </span>
            {item.isHq && <HqBadge />}
          </span>
          <span className={styles.total}>
            <strong>{numberFormat.format(item.totalQuantity)}</strong> total
          </span>
          <span aria-hidden="true" className={styles.chevron}>
            ›
          </span>
          <span className={styles.preview}>
            {preview.map((holder) => (
              <span key={holder.key} className={styles.entry}>
                <span className={styles.holderName} title={holder.label}>
                  {holder.label}
                </span>{" "}
                <b>{numberFormat.format(holder.quantity)}</b>
              </span>
            ))}
            {remaining > 0 && <span className={styles.more}>+{remaining} more</span>}
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
