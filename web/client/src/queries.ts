import type { ItemsInCommonResponse, OverviewResponse, OwnerItems, WondrousTailsResponse } from "../../src/api-types.ts";
import type { AlsoInResponse } from "../../src/item-overlap.ts";
import { api } from "./api.ts";
import { prefetch } from "./hooks.ts";
import type { View } from "./views.ts";

/** A cached API read: `key` names it in the client cache (hooks.ts), `load` fetches it. */
export interface Query<T> {
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
}

/** Every cached read the views make, defined once so a view and a prefetch can't disagree on the key. */
export const queries = {
  overview: { key: "overview", load: (signal) => api.overview(signal) } satisfies Query<OverviewResponse>,
  itemsInCommon: { key: "items-in-common", load: (signal) => api.itemsInCommon(signal) } satisfies Query<ItemsInCommonResponse>,
  wondrousTails: { key: "wondrous-tails", load: (signal) => api.wondrousTails(signal) } satisfies Query<WondrousTailsResponse>,
  ownerItems: (ownerId: string): Query<OwnerItems> => ({
    key: `owner-items:${ownerId}`,
    load: (signal) => api.ownerItems(ownerId, signal),
  }),
  alsoIn: (ownerId: string): Query<AlsoInResponse> => ({ key: `also-in:${ownerId}`, load: (signal) => api.alsoIn(ownerId, signal) }),
};

/**
 * Starts loading what a tab shows before it's on screen: at startup (alongside the sign-in check)
 * and when the pointer or focus reaches a tab, so the data is often there by the time it opens.
 */
export function prefetchView(view: View): void {
  if (view === "overview") {
    // Both at once: "Items in common" used to wait for the overview to finish first.
    prefetch(queries.overview);
    prefetch(queries.itemsInCommon);
  } else if (view === "wt") {
    prefetch(queries.wondrousTails);
  }
}
