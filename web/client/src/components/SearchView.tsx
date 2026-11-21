import { useEffect, useState } from "react";
import type { SearchResponse } from "../../../src/api-types.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import { numberFormat } from "../format.ts";
import { useDebounced } from "../hooks.ts";
import { useSignedOut } from "../session.ts";
import { ItemCard } from "./ItemCard.tsx";
import styles from "./SearchView.module.css";
import ui from "./ui.module.css";

const DEBOUNCE_MS = 250;

type State =
  | { status: "idle"; message: string }
  | { status: "loading" }
  | { status: "done"; q: string; data: SearchResponse }
  | { status: "error"; message: string };

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SearchView({ query, onQueryChange }: Props) {
  const signedOut = useSignedOut();
  const debounced = useDebounced(query.trim(), DEBOUNCE_MS);
  const [state, setState] = useState<State>({ status: "idle", message: "" });

  useEffect(() => {
    const q = debounced;
    if (q.length < 2 && !/^\d+$/.test(q)) {
      setState({ status: "idle", message: q ? "Keep typing…" : "" });
      return;
    }

    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .search(q, controller.signal)
      .then((data) => setState({ status: "done", q, data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof Unauthorized) return signedOut();
        setState({ status: "error", message: `Search failed: ${errorMessage(error)}` });
      });
    return () => controller.abort();
  }, [debounced, signedOut]);

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
        // biome-ignore lint/a11y/noAutofocus: the search box is the whole point of this tab.
        autoFocus
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {!query.trim() && <div className={styles.chart} aria-hidden="true" />}
      <p className={`${ui.muted} ${styles.status}`} aria-live="polite">
        {statusText(state)}
      </p>
      {state.status === "done" && state.data.hits.map((hit) => <ItemCard key={`${hit.itemId}:${hit.isHq}`} hit={hit} />)}
    </section>
  );
}

function statusText(state: State): string {
  switch (state.status) {
    case "idle":
    case "error":
      return state.message;
    case "loading":
      return "Searching…";
    case "done": {
      const { hits, truncated } = state.data;
      if (hits.length === 0) return `Nobody has anything matching "${state.q}" (as of their last upload).`;
      const total = hits.reduce((sum, hit) => sum + hit.totalQuantity, 0);
      return `${hits.length} item${hits.length === 1 ? "" : "s"} · ${numberFormat.format(total)} total${truncated ? " · showing the first matches, refine your search" : ""}`;
    }
  }
}
