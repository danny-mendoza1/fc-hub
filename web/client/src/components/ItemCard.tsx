import type { SearchHit } from "../../../src/api-types.ts";
import { numberFormat } from "../format.ts";
import { Age, HqBadge, Holder } from "./Bits.tsx";
import ui from "./ui.module.css";
import styles from "./ItemCard.module.css";

/** One search result: an item (+HQ) and everyone holding it, down to the slot. */
export function ItemCard({ hit }: { hit: SearchHit }) {
  return (
    <article className={`${ui.card} ${styles.item}`}>
      <div className={styles.head}>
        <span className={styles.name}>{hit.name || `Item #${hit.itemId}`}</span>
        {hit.isHq && <HqBadge />}
        <span className={styles.itemId}>#{hit.itemId}</span>
        <span className={styles.total}>
          Total <strong>{numberFormat.format(hit.totalQuantity)}</strong>
        </span>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.colMember}>Member</th>
            <th className={styles.colHeldBy}>Held by</th>
            <th className={styles.colQty}>Qty</th>
            <th className={styles.colWhere}>Where</th>
            <th className={styles.colUpdated}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {hit.holdings.map((h) => (
            <tr key={h.ownerId} className={styles.row}>
              <td className={styles.member}>{h.member}</td>
              <td className={styles.heldBy}>
                <Holder kind={h.ownerKind} name={h.ownerName} />
                {h.ownerKind === "retainer" && <div className={ui.muted}>{h.character}'s retainer</div>}
              </td>
              <td className={styles.qty}>{numberFormat.format(h.quantity)}</td>
              <td className={styles.where}>
                <ul className={styles.locations}>
                  {h.locations.map((l, i) => (
                    <li key={i}>{h.locations.length > 1 ? `${numberFormat.format(l.quantity)} × ${l.location}` : l.location}</li>
                  ))}
                </ul>
              </td>
              <td className={styles.updated}>
                <Age iso={h.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
