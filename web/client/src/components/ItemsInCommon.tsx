import { useMemo, useState } from "react";
import { commonItems } from "../../../src/item-overlap.ts";
import { api } from "../api.ts";
import { numberFormat } from "../format.ts";
import { useApi, usePartySelection } from "../hooks.ts";
import { CommonItemRow } from "./CommonItemRow.tsx";
import styles from "./ItemsInCommon.module.css";
import { PartyPicker } from "./PartyPicker.tsx";
import ui from "./ui.module.css";

/** Rows shown before "Show all", so the character list below stays within reach. */
const FIRST_ROWS = 15;

/**
 * Items that two or more of a chosen party store (members, plus the FC chest and houses as their
 * own "holders"), to spot what could be consolidated. Works like Wondrous Tails' duties in common.
 */
export function ItemsInCommon() {
  const state = useApi((signal) => api.itemsInCommon(signal), [], { cacheKey: "items-in-common" });
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  const holders = useMemo(() => (state.status === "done" ? state.data.holders : []), [state]);
  const holderKeys = useMemo(() => holders.map((h) => h.key), [holders]);
  // Until someone picks, compare everyone.
  const { party, toggle } = usePartySelection("fchub.items.party", holderKeys, () => holderKeys);
  const common = useMemo(() => (state.status === "done" ? commonItems(state.data.items, party) : []), [state, party]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? common.filter((i) => i.name.toLowerCase().includes(q)) : common;
  }, [common, filter]);

  const shown = showAll || filter.trim() ? filtered : filtered.slice(0, FIRST_ROWS);

  return (
    <article className={`${ui.card} ${ui.inCommonCard}`}>
      <h2 className={ui.sectionHeading}>Items in common</h2>
      <p className={`${ui.muted} ${styles.intro}`}>
        Items that two or more of the party keep in storage (bags, saddlebags, armoury, retainers, FC chest), so you can see what could be
        stacked in one place. Equipped gear, market listings and crystals aren't counted.
      </p>

      {state.status === "loading" && <p className={ui.muted}>Loading…</p>}
      {state.status === "error" && <p className={ui.error}>{state.message}</p>}
      {state.status === "done" && (
        <>
          <PartyPicker
            label="Compare"
            ariaLabel="Compare storage of"
            options={holders.map((h) => ({ key: h.key, label: h.label }))}
            selected={party}
            onToggle={toggle}
          />

          {party.size < 2 ? (
            <p className={ui.muted}>Pick at least two to compare.</p>
          ) : common.length === 0 ? (
            <p className={ui.muted}>Nothing in common in storage. Try a different selection.</p>
          ) : (
            <>
              <input
                type="search"
                className={styles.filter}
                placeholder={`Filter ${numberFormat.format(common.length)} items in common…`}
                aria-label="Filter items in common"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {filtered.length === 0 ? (
                <p className={ui.muted}>No items in common match “{filter.trim()}”.</p>
              ) : (
                <ul className={ui.rankedList}>
                  {shown.map((item) => (
                    <CommonItemRow key={`${item.itemId}:${item.isHq}`} item={item} />
                  ))}
                </ul>
              )}
              {shown.length < filtered.length && (
                <button type="button" className={`${ui.linkButton} ${styles.more}`} onClick={() => setShowAll(true)}>
                  Show all {numberFormat.format(filtered.length)}
                </button>
              )}
            </>
          )}
        </>
      )}
    </article>
  );
}
