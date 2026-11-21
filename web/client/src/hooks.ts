import { type DependencyList, useEffect, useMemo, useState } from "react";
import { errorMessage, Unauthorized } from "./api.ts";
import { useSignedOut } from "./session.ts";

/** The value, once it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * useState persisted to localStorage (a per-browser convenience, e.g. the chosen party).
 * Storage can be unavailable or throw (private mode, quota), so it silently falls back to memory.
 */
export function usePersistentState<T>(key: string, initial: () => T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial() : (JSON.parse(raw) as T);
    } catch {
      return initial();
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Not persisted; fine.
    }
  };
  return [value, set];
}

export type Loaded<T> = { status: "loading" } | { status: "done"; data: T } | { status: "error"; message: string };

/**
 * Loads data from the API when `deps` change: tracks loading/done/error, drops responses that
 * arrive after the component moved on (the request is aborted), and signs out on a 401.
 */
export function useApi<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList, errorPrefix = "Couldn't load"): Loaded<T> {
  const signedOut = useSignedOut();
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a new closure every render; the caller's `deps` say when it really changes.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    load(controller.signal)
      .then((data) => !controller.signal.aborted && setState({ status: "done", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof Unauthorized) return signedOut();
        setState({ status: "error", message: `${errorPrefix}: ${errorMessage(error)}` });
      });
    return () => controller.abort();
  }, [...deps, signedOut]);

  return state;
}

/**
 * Who's selected in a party picker (Wondrous Tails, Items in common), remembered per browser.
 * Until someone picks, the selection is `defaults()`. Keys no longer available are ignored.
 */
export function usePartySelection<K extends string | number>(
  storageKey: string,
  available: readonly K[],
  defaults: () => readonly K[],
): { party: ReadonlySet<K>; toggle: (key: K) => void } {
  // null = never chosen in this browser.
  const [saved, setSaved] = usePersistentState<K[] | null>(storageKey, () => null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `defaults` is a new closure every render and only matters until a choice is saved.
  const party = useMemo(() => new Set(saved === null ? defaults() : saved.filter((key) => available.includes(key))), [saved, available]);
  const toggle = (key: K) => {
    const next = new Set(party);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSaved([...next]);
  };
  return { party, toggle };
}
