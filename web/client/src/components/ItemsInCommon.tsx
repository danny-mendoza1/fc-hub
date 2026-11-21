import { useEffect, useMemo, useState } from "react";
import type { CommonItem, ItemsInCommonResponse } from "../../../src/api-types.ts";
import { commonItems } from "../../../src/item-overlap.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import { numberFormat, placeTitle, placeWhere } from "../format.ts";
import { usePersistentState } from "../hooks.ts";
import { HqBadge } from "./Bits.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import ui from "./ui.module.css";
import styles from "./ItemsInCommon.module.css";

type State = { status: "loading" } | { status: "done"; data: ItemsInCommonResponse } | { status: "error"; message: string };

/** Rows shown before "Show all", so the character list below stays within reach. */
const FIRST_ROWS = 15;

/**
 * Items that two or more of a chosen party store (members, plus the FC chest and houses as their
 * own "holders"), to spot what could be consolidated. Works like Wondrous Tails' duties in common.
 */
export function ItemsInCommon({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  // null = never chosen: default to everyone.
  const [savedParty, setSavedParty] = usePersistentState<string[] | null>("fchub.items.party", () => null);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .itemsInCommon()
      .then((data) => !cancelled && setState({ status: "done", data }))
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof Unauthorized) return onUnauthorized();
        setState({ status: "error", message: `Couldn't load: ${errorMessage(error)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const holders = state.status === "done" ? state.data.holders : [];
  const party = useMemo(
    () => new Set(savedParty === null ? holders.map((h) => h.key) : savedParty.filter((k) => holders.some((h) => h.key === k))),
    [savedParty, holders],
  );
  const common = useMemo(() => (state.status === "done" ? commonItems(state.data.items, party) : []), [state, party]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? common.filter((i) => i.name.toLowerCase().includes(q)) : common;
  }, [common, filter]);

  const toggle = (key: string) => {
    const next = new Set(party);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSavedParty([...next]);
  };

  const shown = showAll || filter.trim() ? filtered : filtered.slice(0, FIRST_ROWS);

  return (
    <article className={`${ui.card} ${styles.common}`}>
      <h2 className={styles.heading}>Items in common</h2>
      <p className={`${ui.muted} ${styles.intro}`}>
        Items that two or more of the party keep in storage (bags, saddlebags, armoury, retainers, FC chest), so you can see what
        could be stacked in one place. Equipped gear, market listings and crystals aren't counted.
      </p>

      {state.status === "loading" && <p className={ui.muted}>Loading…</p>}
      {state.status === "error" && <p className={ui.error}>{state.message}</p>}
      {state.status === "done" && (
        <>
          <div className={ui.party} role="group" aria-label="Compare storage of">
            <span className={ui.partyLabel}>Compare</span>
            {holders.map((h) => (
              <button key={h.key} type="button" className={ui.chip} aria-pressed={party.has(h.key)} onClick={() => toggle(h.key)}>
                {h.label}
              </button>
            ))}
          </div>

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
                <ul className={styles.list}>
                  {shown.map((item) => (
                    <Row key={`${item.itemId}:${item.isHq}`} item={item} />
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

function Row({ item }: { item: CommonItem }) {
  return (
    <li className={styles.row}>
      <ItemIcon iconId={item.iconId} size="large" />
      <div className={styles.body}>
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
      <span className={styles.count} title={`Stored by ${item.holders.length} of the selection`}>
        {item.holders.length}
      </span>
    </li>
  );
}
