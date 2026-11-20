/**
 * Response shapes of the JSON API, shared with the React client (web/client) via type-only
 * imports, so the UI and the server can't silently disagree.
 */
import type { Member } from "./auth.ts";
import type { OverviewCharacter, SearchHit } from "./search.ts";

export type { Holding, OverviewCharacter, OverviewOwner, OwnerItem, OwnerItems, OwnerSection, SearchHit } from "./search.ts";
export type { Member } from "./auth.ts";
export { MAX_QUERY_LENGTH } from "./search.ts";

export interface MeCharacter {
  contentId: string;
  name: string;
  homeWorld: string | null;
  lastUploadAt: string;
}

/** GET /api/v1/me */
export interface MeResponse {
  member: Member;
  characters: MeCharacter[];
}

/** POST /api/v1/session */
export interface SessionResponse {
  member: Member;
}

/** GET /api/v1/search */
export interface SearchResponse {
  hits: SearchHit[];
  truncated: boolean;
}

/** GET /api/v1/overview */
export interface OverviewResponse {
  characters: OverviewCharacter[];
}

/** GET /api/v1/owners/:ownerId/items is `OwnerItems`. GET /api/v1/icons/:iconId is image/png. */

/** Every error response. */
export interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}
