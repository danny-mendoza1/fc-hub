/**
 * Wondrous Tails: upload contract, book status and "duties in common".
 *
 * Browser-safe (no Node or DB imports): the React client imports `commonDuties` and the types,
 * so the server and the UI share one tested implementation.
 *
 * Game rules this encodes:
 * - Weekly reset is Tuesdays 08:00 UTC; a new journal is available each week.
 * - A journal can be kept for two weeks from the reset it was issued after, so its expiry is
 *   either the coming reset (last week's book) or the reset after that (this week's book).
 * - A new journal can't be taken while holding an unexpired one.
 */

export const WT_SCHEMA_VERSION = 1;
export const WT_SLOT_COUNT = 16;

export type SlotStatus = "open" | "claimable" | "claimed";

export interface WtSlot {
  index: number;
  orderId: number;
  name: string;
  iconId: number;
  /** WeeklyBingoOrderData.Type: 0 = a specific duty; others are categories (kept for later matching). */
  type: number;
  dataId: number;
  status: SlotStatus;
}

export interface WtUpload {
  schemaVersion: number;
  pluginVersion: string;
  capturedAt: string;
  character: { contentId: string; name: string; homeWorldId: number; homeWorld: string | null };
  hasJournal: boolean;
  isExpired: boolean;
  expiresAt: string | null;
  secondChancePoints: number;
  stickersPlaced: number;
  slots: WtSlot[];
}

/**
 * current   - this week's journal
 * previous  - last week's journal, still valid until the coming reset
 * expired   - holding a journal that can no longer be turned in (trade it in with Khloe)
 * turnedIn  - had a journal earlier this week and handed it in
 * none      - no journal (not picked up, or handed in before this week)
 * unknown   - this member's plugin hasn't uploaded Wondrous Tails yet
 */
export type BookStatus = "current" | "previous" | "expired" | "turnedIn" | "none" | "unknown";

export interface WtBook {
  memberId: number;
  member: string;
  character: string | null;
  homeWorld: string | null;
  status: BookStatus;
  /** Captured before this week's reset; the player may have a different book now. */
  stale: boolean;
  /** No journal held and none handed in this week, so a new one can be picked up. */
  newJournalAvailable: boolean;
  capturedAt: string | null;
  expiresAt: string | null;
  secondChancePoints: number;
  stickersPlaced: number;
  slots: WtSlot[];
}

/** GET /api/v1/wondrous-tails */
export interface WondrousTailsResponse {
  lastReset: string;
  nextReset: string;
  books: WtBook[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most recent and the next weekly reset (Tuesdays 08:00 UTC) around `now`. */
export function weeklyResets(now: Date): { lastReset: Date; nextReset: Date } {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8));
  reset.setUTCDate(reset.getUTCDate() - ((now.getUTCDay() - 2 + 7) % 7));
  const lastReset = reset > now ? new Date(reset.getTime() - WEEK_MS) : reset;
  return { lastReset, nextReset: new Date(lastReset.getTime() + WEEK_MS) };
}

export interface StoredBook {
  hasJournal: boolean;
  isExpired: boolean;
  expiresAt: string | null;
  capturedAt: string;
  turnedInAt: string | null;
  turnedInExpiresAt: string | null;
}

/** Book status at `now` from the last upload (statuses age as resets pass, without new uploads). */
export function bookStatus(book: StoredBook | null, now: Date): { status: BookStatus; stale: boolean; newJournalAvailable: boolean } {
  if (!book) return { status: "unknown", stale: false, newJournalAvailable: false };

  const { lastReset, nextReset } = weeklyResets(now);
  const stale = Date.parse(book.capturedAt) < lastReset.getTime();

  if (book.hasJournal) {
    const expires = book.expiresAt ? Date.parse(book.expiresAt) : Number.NaN;
    if (book.isExpired || !(expires > now.getTime())) return { status: "expired", stale, newJournalAvailable: false };
    // Expiry lands on a reset; allow a day of slack either way.
    if (expires <= nextReset.getTime() + DAY_MS) return { status: "previous", stale, newJournalAvailable: false };
    return { status: "current", stale, newJournalAvailable: false };
  }

  if (book.turnedInAt && Date.parse(book.turnedInAt) >= lastReset.getTime()) {
    // Handing in last week's book this week leaves this week's journal still to pick up.
    const handedInLastWeeks = book.turnedInExpiresAt !== null && Date.parse(book.turnedInExpiresAt) <= nextReset.getTime() + DAY_MS;
    return { status: "turnedIn", stale, newJournalAvailable: handedInLastWeeks };
  }

  return { status: "none", stale, newJournalAvailable: true };
}

export function isActive(status: BookStatus): boolean {
  return status === "current" || status === "previous";
}

export interface CommonDuty {
  orderId: number;
  name: string;
  iconId: number;
  /** Members who still need it. */
  needs: { memberId: number; member: string }[];
  /** Members who've done it (sticker placed or not), and how many second chances they hold. */
  done: { memberId: number; member: string; secondChancePoints: number }[];
}

/**
 * Objectives (exact WeeklyBingoOrderData match) that appear in at least two of the selected
 * members' active books and that at least one of them still needs. Members who've already done
 * it are listed separately with their second chances, since a second chance lets them redo it
 * alongside the others. Sorted by how many still need it.
 */
export function commonDuties(books: WtBook[], selectedMemberIds: ReadonlySet<number>): CommonDuty[] {
  const byOrder = new Map<number, CommonDuty>();
  for (const book of books) {
    if (!selectedMemberIds.has(book.memberId) || !isActive(book.status)) continue;
    const seen = new Set<number>();
    for (const slot of book.slots) {
      if (slot.orderId === 0 || seen.has(slot.orderId)) continue;
      seen.add(slot.orderId);
      let duty = byOrder.get(slot.orderId);
      if (!duty) {
        duty = { orderId: slot.orderId, name: slot.name, iconId: slot.iconId, needs: [], done: [] };
        byOrder.set(slot.orderId, duty);
      }
      if (slot.status === "open") duty.needs.push({ memberId: book.memberId, member: book.member });
      else duty.done.push({ memberId: book.memberId, member: book.member, secondChancePoints: book.secondChancePoints });
    }
  }

  return [...byOrder.values()]
    .filter((d) => d.needs.length + d.done.length >= 2 && d.needs.length >= 1)
    .sort((a, b) => b.needs.length - a.needs.length || b.done.length - a.done.length || a.name.localeCompare(b.name));
}

// --- validation -------------------------------------------------------------------------

const SLOT_STATUSES: readonly string[] = ["open", "claimable", "claimed"];

export function validateWondrousTails(input: unknown): { ok: true; value: WtUpload } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const obj = (v: unknown, path: string) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    errors.push(`${path} must be an object`);
    return undefined;
  };
  const int = (v: unknown, path: string, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max) return v;
    errors.push(`${path} must be an integer between 0 and ${max}`);
    return 0;
  };
  const text = (v: unknown, path: string, allowEmpty = false) => {
    if (typeof v === "string" && v.length <= 200 && (allowEmpty || v.length > 0)) return v;
    errors.push(`${path} must be a string of at most 200 characters`);
    return "";
  };
  const bool = (v: unknown, path: string) => {
    if (typeof v === "boolean") return v;
    errors.push(`${path} must be a boolean`);
    return false;
  };
  const time = (v: unknown, path: string) => {
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
    errors.push(`${path} must be an ISO timestamp`);
    return "";
  };

  const root = obj(input, "body");
  if (!root) return { ok: false, errors };
  if (root.schemaVersion !== WT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${WT_SCHEMA_VERSION}`);

  const c = obj(root.character, "character");
  const contentId = c?.contentId;
  if (typeof contentId !== "string" || !/^[1-9][0-9]{0,19}$/.test(contentId)) errors.push("character.contentId must be a decimal id string");

  const hasJournal = bool(root.hasJournal, "hasJournal");
  const slotsIn = Array.isArray(root.slots) ? root.slots : (errors.push("slots must be an array"), []);
  if (hasJournal && slotsIn.length !== WT_SLOT_COUNT) errors.push(`slots must have ${WT_SLOT_COUNT} entries when hasJournal is true`);
  if (!hasJournal && slotsIn.length !== 0) errors.push("slots must be empty when hasJournal is false");

  const slots = slotsIn.slice(0, WT_SLOT_COUNT).map((s, i) => {
    const slot = obj(s, `slots[${i}]`) ?? {};
    const status = slot.status;
    if (typeof status !== "string" || !SLOT_STATUSES.includes(status)) errors.push(`slots[${i}].status is invalid`);
    return {
      index: int(slot.index, `slots[${i}].index`, WT_SLOT_COUNT - 1),
      orderId: int(slot.orderId, `slots[${i}].orderId`, 65_535),
      name: text(slot.name, `slots[${i}].name`, true),
      iconId: int(slot.iconId, `slots[${i}].iconId`, 999_999),
      type: int(slot.type, `slots[${i}].type`, 255),
      dataId: int(slot.dataId, `slots[${i}].dataId`),
      status: status as SlotStatus,
    };
  });

  const value: WtUpload = {
    schemaVersion: WT_SCHEMA_VERSION,
    pluginVersion: typeof root.pluginVersion === "string" ? root.pluginVersion.slice(0, 40) : "",
    capturedAt: time(root.capturedAt, "capturedAt"),
    character: {
      contentId: typeof contentId === "string" ? contentId : "",
      name: text(c?.name, "character.name"),
      homeWorldId: int(c?.homeWorldId, "character.homeWorldId"),
      homeWorld: c?.homeWorld === null || c?.homeWorld === undefined ? null : text(c.homeWorld, "character.homeWorld", true),
    },
    hasJournal,
    isExpired: bool(root.isExpired, "isExpired"),
    expiresAt: hasJournal ? time(root.expiresAt, "expiresAt") : null,
    secondChancePoints: int(root.secondChancePoints, "secondChancePoints", 99),
    stickersPlaced: int(root.stickersPlaced, "stickersPlaced", WT_SLOT_COUNT),
    slots,
  };

  return errors.length > 0 ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, value };
}
