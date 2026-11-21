import { useEffect, useMemo, useState } from "react";
import { errorMessage, Unauthorized } from "./api.ts";
import type { Query } from "./queries.ts";
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

/** How long a loaded response is reused as is when a view is shown again (switching tabs, reopening a row). */
export const FRESH_FOR_MS = 30_000;

/**
 * Up to this age a cached response is shown at once while a fresh copy loads in the background
 * (stale-while-revalidate), instead of "Loading…". Older than this, the view waits for new data.
 */
export const STALE_FOR_MS = 10 * 60_000;

/**
 * Responses kept in memory, by query key. Memory only: a page reload always starts fresh, and
 * signing out clears it.
 */
const recent = new Map<string, { at: number; data: unknown }>();

/** Requests under way, by query key, so a prefetch and the view that then needs it share one request. */
const inflight = new Map<string, Promise<unknown>>();

/** Bumped on sign-out, so a response from the old session that lands afterwards isn't cached. */
let generation = 0;

export function clearApiCache(): void {
  recent.clear();
  inflight.clear();
  generation++;
}

function cached<T>(key: string, maxAgeMs: number): T | undefined {
  const hit = recent.get(key);
  return hit && Date.now() - hit.at < maxAgeMs ? (hit.data as T) : undefined;
}

/**
 * Loads `query`, sharing the request with anyone else asking for the same key meanwhile, and
 * caches the result. Shared requests aren't aborted when one caller goes away: the response is
 * cached for the next one, and these reads are small.
 */
function loadShared<T>(query: Query<T>): Promise<T> {
  const pending = inflight.get(query.key);
  if (pending) return pending as Promise<T>;
  const started = generation;
  const request: Promise<T> = query
    .load(new AbortController().signal)
    .then((data) => {
      if (started === generation) recent.set(query.key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (inflight.get(query.key) === request) inflight.delete(query.key);
    });
  inflight.set(query.key, request);
  return request;
}

/** Starts loading `query` unless it's fresh or already loading. Errors are left for the view that shows it. */
export function prefetch<T>(query: Query<T>): void {
  if (cached(query.key, FRESH_FOR_MS) !== undefined) return;
  loadShared(query).catch(() => undefined);
}

export interface UseApiOptions {
  /** Prefixes the error message ("Couldn't load: ..."). */
  errorPrefix?: string;
}

/**
 * Loads `query` (see queries.ts): tracks loading/done/error, signs out on a 401, reuses a fresh
 * response without asking again, and shows a stale one at once while refreshing it.
 */
export function useApi<T>(query: Query<T>, options: UseApiOptions = {}): Loaded<T> {
  const { errorPrefix = "Couldn't load" } = options;
  const signedOut = useSignedOut();
  const [state, setState] = useState<Loaded<T>>(() => {
    const hit = cached<T>(query.key, STALE_FOR_MS);
    return hit === undefined ? { status: "loading" } : { status: "done", data: hit };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is a new object every render; its key says when it really changes.
  useEffect(() => {
    // Keep the same state object when the data hasn't changed, so memos that depend on it don't rerun.
    const show = (data: T) => setState((prev) => (prev.status === "done" && prev.data === data ? prev : { status: "done", data }));
    const fresh = cached<T>(query.key, FRESH_FOR_MS);
    if (fresh !== undefined) return show(fresh);

    const stale = cached<T>(query.key, STALE_FOR_MS);
    if (stale === undefined) setState({ status: "loading" });
    else show(stale);

    let active = true;
    loadShared(query)
      .then((data) => active && show(data))
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof Unauthorized) return signedOut();
        // A failed refresh keeps showing what was already there.
        if (stale === undefined) setState({ status: "error", message: `${errorPrefix}: ${errorMessage(error)}` });
      });
    return () => {
      active = false;
    };
  }, [query.key, signedOut]);

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
