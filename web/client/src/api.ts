import type {
  AlsoInResponse,
  ErrorResponse,
  ItemsInCommonResponse,
  MeResponse,
  OverviewResponse,
  OwnerItems,
  SearchResponse,
  SessionResponse,
  WondrousTailsResponse,
} from "../../src/api-types.ts";

/** The session cookie is missing, expired or revoked. */
export class Unauthorized extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401) throw new Unauthorized();
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | ErrorResponse | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  me: () => request<MeResponse>("/api/v1/me"),

  signIn: (apiKey: string) =>
    request<SessionResponse>("/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }),

  signOut: () => request<void>("/api/v1/session", { method: "DELETE" }),

  search: (q: string, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/v1/search?q=${encodeURIComponent(q)}`, { signal }),

  overview: (signal?: AbortSignal) => request<OverviewResponse>("/api/v1/overview", { signal }),

  wondrousTails: (signal?: AbortSignal) => request<WondrousTailsResponse>("/api/v1/wondrous-tails", { signal }),

  ownerItems: (ownerId: string, signal?: AbortSignal) =>
    request<OwnerItems>(`/api/v1/owners/${encodeURIComponent(ownerId)}/items`, { signal }),

  alsoIn: (ownerId: string, signal?: AbortSignal) =>
    request<AlsoInResponse>(`/api/v1/owners/${encodeURIComponent(ownerId)}/also-in`, { signal }),

  itemsInCommon: (signal?: AbortSignal) => request<ItemsInCommonResponse>("/api/v1/items/in-common", { signal }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
