import { useEffect, useRef, useState } from "react";
import type { SearchResponse } from "../../../src/api-types.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import aquarium from "../art/aquarium.webp";
import classChange from "../art/class-change.webp";
import classChangeStill from "../art/class-change-still.webp";
import { numberFormat } from "../format.ts";
import { useDebounced } from "../hooks.ts";
import { useSignedOut } from "../session.ts";
import { ItemCard } from "./ItemCard.tsx";
import styles from "./SearchView.module.css";

const DEBOUNCE_MS = 250;

type Result =
  | { status: "done"; q: string; data: SearchResponse; playClassChange: boolean }
  | { status: "error"; q: string; message: string };

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SearchView({ query, onQueryChange }: Props) {
  const signedOut = useSignedOut();
  const term = query.trim();
  const debounced = useDebounced(term, DEBOUNCE_MS);
  const searchable = term.length >= 2 || /^\d+$/.test(term);
  const previousWasEmpty = useRef(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!term) previousWasEmpty.current = false;
    setResult(null);
    if (!searchable || term !== debounced) return;

    const controller = new AbortController();
    api
      .search(term, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const empty = data.hits.length === 0;
        setResult({ status: "done", q: term, data, playClassChange: empty && !previousWasEmpty.current });
        // Refining one miss into another should keep the scene still.
        previousWasEmpty.current = empty;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof Unauthorized) return signedOut();
        setResult({ status: "error", q: term, message: `Search failed: ${errorMessage(error)}` });
      });
    return () => controller.abort();
  }, [term, debounced, searchable, signedOut]);

  const current = result?.q === term ? result : null;
  const done = current?.status === "done" ? current : null;
  const { title, detail } = feedback(term, searchable, current);

  return (
    <section>
      <label className={styles.title} htmlFor="inventory-search">
        Inventory search
      </label>
      <input
        id="inventory-search"
        className={styles.search}
        type="search"
        placeholder="Search items: tincture, iron ore, or an item id"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {!term && <div className={styles.house} aria-hidden="true" />}
      <div className={done ? styles.frame : undefined}>
        <div className={done ? styles.banner : undefined}>
          {done && (
            <picture className={styles.scene}>
              {done.playClassChange && <source media="(prefers-reduced-motion: no-preference)" srcSet={classChange} />}
              <img src={done.data.hits.length ? aquarium : classChangeStill} alt="" />
            </picture>
          )}
          <div role="status" aria-atomic="true" className={done ? styles.caption : styles.status}>
            {title && <strong>{title}</strong>}
            {detail && <span>{detail}</span>}
          </div>
        </div>
        {done?.data.hits.map((hit) => (
          <ItemCard key={`${hit.itemId}:${hit.isHq}`} hit={hit} />
        ))}
      </div>
    </section>
  );
}

function feedback(term: string, searchable: boolean, result: Result | null) {
  if (!term) return { detail: "" };
  if (!searchable) return { detail: "Keep typing." };
  if (result?.status === "error") return { detail: result.message };
  if (!result) return { detail: "Searching." };

  const { hits, truncated } = result.data;
  if (!hits.length) return { title: "No items found", detail: "No matches in the latest uploads. Try another name or item ID." };
  const total = hits.reduce((sum, hit) => sum + hit.totalQuantity, 0);
  return {
    title: `${hits.length} item${hits.length === 1 ? "" : "s"} found`,
    detail: `${numberFormat.format(total)} total${truncated ? " · showing the first matches, refine your search" : ""}`,
  };
}
