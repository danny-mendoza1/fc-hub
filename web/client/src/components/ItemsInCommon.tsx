import { useMemo, useState } from "react";
import type { CommonItem } from "../../../src/api-types.ts";
import { commonItems, isSharedStorage, itemKey } from "../../../src/item-overlap.ts";
import { numberFormat, placeWhere, SECTION_LABELS } from "../format.ts";
import { useApi, usePartySelection } from "../hooks.ts";
import { queries } from "../queries.ts";
import { CommonItemRow } from "./CommonItemRow.tsx";
import styles from "./ItemsInCommon.module.css";
import { PartyPicker } from "./PartyPicker.tsx";
import ui from "./ui.module.css";

const PAGE_SIZE = 6;

function searchText(item: CommonItem) {
  const fields = [item.name, String(item.itemId), item.isHq ? "HQ" : "NQ"];
  for (const holder of item.holders) {
    fields.push(holder.label);
    for (const place of holder.places) {
      fields.push(placeWhere(place), SECTION_LABELS[place.section] ?? place.section, place.ownerName ?? "");
      if (!isSharedStorage(place.ownerKind)) fields.push(place.character);
    }
  }
  return fields.join(" ").toLowerCase();
}

export function ItemsInCommon() {
  const state = useApi(queries.itemsInCommon);
  const [filter, setFilter] = useState("");
  const [quality, setQuality] = useState("all");
  const [order, setOrder] = useState("holders");
  const [page, setPage] = useState(0);
  const holders = useMemo(() => (state.status === "done" ? state.data.holders : []), [state]);
  const holderKeys = useMemo(() => holders.map((h) => h.key), [holders]);
  const { party, toggle } = usePartySelection("fchub.items.party", holderKeys, () => holderKeys);
  const items = useMemo(() => {
    if (state.status !== "done") return [];
    return commonItems(state.data.items, party).map((item) => ({ item, text: searchText(item) }));
  }, [state, party]);
  const matches = useMemo(() => {
    const words = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const rows = items
      .filter(({ item, text }) => (quality === "all" || item.isHq === (quality === "hq")) && words.every((word) => text.includes(word)))
      .map(({ item }) => item);
    if (order === "quantity") rows.sort((a, b) => b.totalQuantity - a.totalQuantity || a.name.localeCompare(b.name));
    if (order === "name") rows.sort((a, b) => a.name.localeCompare(b.name) || Number(a.isHq) - Number(b.isHq));
    return rows;
  }, [items, filter, quality, order]);
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const current = Math.min(page, Math.max(0, pages - 1));
  const start = current * PAGE_SIZE;

  return (
    <article className={`${ui.card} ${ui.inCommonCard}`}>
      <header className={styles.head}>
        <h2 className={ui.sectionHeading}>Items in common</h2>
        <a href="#inventories" className={styles.jump}>
          Individual inventories ↓
        </a>
      </header>
      <p className={styles.intro}>
        Compare items kept by at least two selected holders. Equipped gear, market listings and crystals are excluded.
      </p>
      {state.status === "loading" && <p className={ui.muted}>Loading…</p>}
      {state.status === "error" && <p className={ui.error}>{state.message}</p>}
      {state.status === "done" && (
        <>
          <PartyPicker
            label="Compare"
            ariaLabel="Compare storage of"
            options={holders}
            selected={party}
            onToggle={(key) => {
              toggle(key);
              setPage(0);
            }}
          />
          {party.size < 2 ? (
            <p>Pick at least two to compare.</p>
          ) : items.length === 0 ? (
            <p>Nothing in common in storage. Try a different selection.</p>
          ) : (
            <>
              <div className={styles.tools}>
                <div className={styles.field}>
                  <label htmlFor="common-filter">Filter items in common</label>
                  <input
                    id="common-filter"
                    type="search"
                    placeholder="Item, ID, holder or location"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setPage(0);
                    }}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="common-quality">Quality</label>
                  <select
                    id="common-quality"
                    value={quality}
                    onChange={(e) => {
                      setQuality(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="all">All qualities</option>
                    <option value="hq">High quality</option>
                    <option value="nq">Normal quality</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="common-order">Sort by</label>
                  <select
                    id="common-order"
                    value={order}
                    onChange={(e) => {
                      setOrder(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="holders">Most holders</option>
                    <option value="quantity">Total quantity</option>
                    <option value="name">Item name</option>
                  </select>
                </div>
              </div>
              {matches.length > 0 && (
                <ul className={styles.grid}>
                  {matches.slice(start, start + PAGE_SIZE).map((item) => (
                    <CommonItemRow key={itemKey(item)} item={item} />
                  ))}
                </ul>
              )}
              <div className={styles.pager}>
                <span role="status">
                  {matches.length
                    ? `${start + 1}–${Math.min(start + PAGE_SIZE, matches.length)} of ${numberFormat.format(matches.length)} items`
                    : "No items match these filters."}
                </span>
                {pages > 1 && (
                  <nav aria-label="Item result pages">
                    <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
                      Previous
                    </button>
                    <button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
                      Next
                    </button>
                  </nav>
                )}
              </div>
            </>
          )}
        </>
      )}
    </article>
  );
}
