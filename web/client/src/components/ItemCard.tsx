import type { SearchHit } from "../../../src/api-types.ts";
import { numberFormat } from "../format.ts";
import { Age, Holder, HqBadge } from "./Bits.tsx";
import styles from "./ItemCard.module.css";
import { ItemIcon } from "./ItemIcon.tsx";
import ui from "./ui.module.css";

/** One search result: an item (+HQ) and everyone holding it, down to the slot. */
export function ItemCard({ hit }: { hit: SearchHit }) {
  const name = hit.name || `Item #${hit.itemId}`;
  return (
    <article className={`${ui.card} ${styles.item}`}>
      <div className={styles.head}>
        <ItemIcon iconId={hit.iconId} size="large" />
        <h2 className={styles.name}>{name}</h2>
        {hit.isHq && <HqBadge />}
        <span className={styles.itemId}>#{hit.itemId}</span>
        <span className={styles.total}>
          Total <strong>{numberFormat.format(hit.totalQuantity)}</strong>
        </span>
      </div>
      <table aria-label={`${name}${hit.isHq ? " HQ" : ""} holdings`} className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.colMember}>
              Member
            </th>
            <th scope="col" className={styles.colHeldBy}>
              Held by
            </th>
            <th scope="col" className={styles.colQty}>
              Qty
            </th>
            <th scope="col" className={styles.colWhere}>
              Where
            </th>
            <th scope="col" className={styles.colUpdated}>
              Updated
            </th>
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
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list from one response, never reordered.
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
