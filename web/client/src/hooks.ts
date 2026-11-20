import { useEffect, useState } from "react";

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
