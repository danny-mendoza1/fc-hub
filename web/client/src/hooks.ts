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

/** How long a loaded response is reused when a view is shown again (switching tabs, reopening a row). */
export const FRESH_FOR_MS = 30_000;

/**
 * Responses kept in memory, by cache key, so going back to a tab within FRESH_FOR_MS shows it at
 * once without a request. Memory only: a page reload always starts fresh, and signing out clears it.
 */
const recent = new Map<string, { at: number; data: unknown }>();

export function clearApiCache(): void {
  recent.clear();
}

function fresh<T>(key: string | undefined): T | undefined {
  const hit = key === undefined ? undefined : recent.get(key);
  return hit && Date.now() - hit.at < FRESH_FOR_MS ? (hit.data as T) : undefined;
}

export interface UseApiOptions {
  /** Reuse the response for FRESH_FOR_MS under this key (e.g. "overview", `owner-items:${id}`). */
  cacheKey?: string;
  /** Prefixes the error message ("Couldn't load: ..."). */
  errorPrefix?: string;
}

/**
 * Loads data from the API when `deps` change: tracks loading/done/error, drops responses that
 * arrive after the component moved on (the request is aborted), signs out on a 401, and with a
 * `cacheKey` reuses a recent response instead of asking again.
 */
export function useApi<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList, options: UseApiOptions = {}): Loaded<T> {
  const { cacheKey, errorPrefix = "Couldn't load" } = options;
  const signedOut = useSignedOut();
  const [state, setState] = useState<Loaded<T>>(() => {
    const cached = fresh<T>(cacheKey);
    return cached === undefined ? { status: "loading" } : { status: "done", data: cached };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a new closure every render; the caller's `deps` (and the cache key derived from them) say when it really changes.
  useEffect(() => {
    const cached = fresh<T>(cacheKey);
    if (cached !== undefined) {
      setState({ status: "done", data: cached });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    load(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (cacheKey !== undefined) recent.set(cacheKey, { at: Date.now(), data });
        setState({ status: "done", data });
      })
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
