import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handle } from "../src/app.ts";
import { bookStatus, commonDuties, type StoredBook, type WtBook, type WtSlot, type WtUpload, weeklyResets } from "../src/wondrous-tails.ts";
import { ALICE, BOB, addMember, call, createEnv } from "./helpers.ts";

// Friday 2026-11-20 20:00 UTC: last reset Tue 17th 08:00, next Tue 24th 08:00.
const NOW = new Date("2026-11-20T20:00:00Z");
const NEXT_RESET = "2026-11-24T08:00:00.000Z";
const RESET_AFTER = "2026-12-01T08:00:00.000Z";

/** 16 objectives; unspecified ones get filler ids unique to `fillerBase` so they never match across books. */
function slots(spec: Record<number, [number, WtSlot["status"]]> = {}, fillerBase = 1000): WtSlot[] {
  return Array.from({ length: 16 }, (_, index) => {
    const [orderId, status] = spec[index] ?? [fillerBase + index, "open"];
    return { index, orderId, name: `Duty ${orderId}`, iconId: 61_000 + orderId, type: 0, dataId: orderId, status };
  });
}

function stored(partial: Partial<StoredBook>): StoredBook {
  return { hasJournal: true, isExpired: false, expiresAt: RESET_AFTER, capturedAt: "2026-11-19T10:00:00Z", turnedInAt: null, turnedInExpiresAt: null, ...partial };
}

describe("weekly resets", () => {
  it("are Tuesdays 08:00 UTC", () => {
    assert.deepEqual(
      Object.values(weeklyResets(NOW)).map((d) => d.toISOString()),
      ["2026-11-17T08:00:00.000Z", NEXT_RESET],
    );
    assert.equal(weeklyResets(new Date("2026-11-24T07:59:59Z")).lastReset.toISOString(), "2026-11-17T08:00:00.000Z");
    assert.equal(weeklyResets(new Date("2026-11-24T08:00:00Z")).lastReset.toISOString(), "2026-11-24T08:00:00.000Z");
    assert.equal(weeklyResets(new Date("2026-11-23T23:00:00Z")).nextReset.toISOString(), NEXT_RESET);
  });
});

describe("book status", () => {
  it("tells this week's book from last week's by its expiry", () => {
    assert.equal(bookStatus(stored({ expiresAt: RESET_AFTER }), NOW).status, "current");
    assert.equal(bookStatus(stored({ expiresAt: NEXT_RESET }), NOW).status, "previous");
    assert.equal(bookStatus(stored({ expiresAt: "2026-11-17T08:00:00Z" }), NOW).status, "expired");
    assert.equal(bookStatus(stored({ isExpired: true }), NOW).status, "expired");
  });

  it("handles no journal, hand-ins and never-uploaded members", () => {
    assert.deepEqual(bookStatus(null, NOW), { status: "unknown", stale: false, newJournalAvailable: false });
    assert.deepEqual(bookStatus(stored({ hasJournal: false, expiresAt: null }), NOW), { status: "none", stale: false, newJournalAvailable: true });

    const handedInThisWeeks = stored({ hasJournal: false, expiresAt: null, turnedInAt: "2026-11-19T12:00:00Z", turnedInExpiresAt: RESET_AFTER });
    assert.deepEqual(bookStatus(handedInThisWeeks, NOW), { status: "turnedIn", stale: false, newJournalAvailable: false });

    const handedInLastWeeks = stored({ hasJournal: false, expiresAt: null, turnedInAt: "2026-11-19T12:00:00Z", turnedInExpiresAt: NEXT_RESET });
    assert.deepEqual(bookStatus(handedInLastWeeks, NOW), { status: "turnedIn", stale: false, newJournalAvailable: true });

    const handedInBeforeReset = stored({ hasJournal: false, expiresAt: null, turnedInAt: "2026-11-15T12:00:00Z", turnedInExpiresAt: NEXT_RESET });
    assert.equal(bookStatus(handedInBeforeReset, NOW).status, "none");
  });

  it("ages without new uploads: this week's book becomes last week's after the reset", () => {
    const book = stored({ expiresAt: RESET_AFTER, capturedAt: "2026-11-19T10:00:00Z" });
    const nextWeek = new Date("2026-11-25T12:00:00Z");
    assert.deepEqual(bookStatus(book, nextWeek), { status: "previous", stale: true, newJournalAvailable: false });
  });
});

describe("duties in common", () => {
  const book = (memberId: number, member: string, status: WtBook["status"], spec: Record<number, [number, WtSlot["status"]]>, secondChancePoints = 0): WtBook => ({
    memberId, member, character: member, homeWorld: "Kraken", status, stale: false, newJournalAvailable: false,
    capturedAt: NOW.toISOString(), expiresAt: RESET_AFTER, secondChancePoints, stickersPlaced: 0, slots: slots(spec, memberId * 1000),
  });

  const danny = book(1, "Danny", "current", { 0: [7, "open"], 1: [8, "open"], 2: [9, "claimed"], 3: [10, "open"] }, 3);
  const wife = book(2, "Wife", "current", { 0: [7, "open"], 1: [8, "claimable"], 2: [9, "open"], 3: [11, "open"] }, 1);
  const friend = book(3, "Friend", "previous", { 0: [7, "open"], 1: [12, "open"] });
  const turnedIn = { ...book(4, "Busy", "turnedIn", {}), slots: [] };

  it("only considers the selected party", () => {
    const duo = commonDuties([danny, wife, friend], new Set([1, 2]));
    assert.deepEqual(duo.map((d) => d.orderId), [7, 8, 9]);
    assert.deepEqual(duo[0]!.needs.map((n) => n.member), ["Danny", "Wife"]);

    const trio = commonDuties([danny, wife, friend], new Set([1, 2, 3]));
    assert.equal(trio[0]!.orderId, 7);
    assert.equal(trio[0]!.needs.length, 3, "everyone still needs duty 7");
  });

  it("lists who already did it, with second chances, and drops duties nobody needs", () => {
    const duo = commonDuties([danny, wife], new Set([1, 2]));
    const eight = duo.find((d) => d.orderId === 8)!;
    assert.deepEqual(eight.needs.map((n) => n.member), ["Danny"]);
    assert.deepEqual(eight.done, [{ memberId: 2, member: "Wife", secondChancePoints: 1 }]);

    const allDone = book(5, "X", "current", { 0: [9, "claimed"] });
    assert.equal(commonDuties([danny, allDone], new Set([1, 5])).find((d) => d.orderId === 9), undefined);
  });

  it("ignores members without an active book and duplicate slots", () => {
    assert.deepEqual(commonDuties([danny, turnedIn], new Set([1, 4])), []);
    const dup = book(6, "Dup", "current", { 0: [7, "open"], 1: [7, "open"] });
    assert.equal(commonDuties([danny, dup], new Set([1, 6]))[0]!.needs.length, 2);
  });
});

describe("Wondrous Tails API", () => {
  let env: ReturnType<typeof createEnv>;
  let alice: string;

  const wt = (partial: Partial<WtUpload> = {}): WtUpload => ({
    schemaVersion: 1,
    pluginVersion: "test",
    capturedAt: new Date().toISOString(),
    character: { contentId: ALICE, name: "Alice Example", homeWorldId: 409, homeWorld: "Kraken" },
    hasJournal: true,
    isExpired: false,
    expiresAt: weeklyResets(new Date()).nextReset.toISOString().replace(/T.*/, "T08:00:00.000Z"),
    secondChancePoints: 2,
    stickersPlaced: 1,
    slots: slots({ 0: [7, "claimed"] }),
    ...partial,
  });
  const thisWeeksExpiry = () => new Date(weeklyResets(new Date()).nextReset.getTime() + 7 * 86_400_000).toISOString();

  beforeEach(async () => {
    env = createEnv();
    alice = await addMember(env, "Alice");
    await addMember(env, "Bob");
  });

  it("stores a journal and lists every member, with never-uploaded ones as unknown", async () => {
    const res = await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ expiresAt: thisWeeksExpiry() }) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "current", turnedInInferred: false });

    const list = await call(env, "GET", "/api/v1/wondrous-tails", { token: alice });
    assert.equal(list.status, 200);
    const [a, b] = list.body.books;
    assert.equal(a.member, "Alice");
    assert.equal(a.character, "Alice Example");
    assert.equal(a.status, "current");
    assert.equal(a.slots.length, 16);
    assert.equal(a.slots[0].status, "claimed");
    assert.equal(a.secondChancePoints, 2);
    assert.deepEqual([b.member, b.status, b.slots.length], ["Bob", "unknown", 0]);
  });

  it("infers a hand-in when a valid journal disappears", async () => {
    await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ expiresAt: thisWeeksExpiry(), capturedAt: new Date(Date.now() - 60_000).toISOString() }) });
    const res = await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ hasJournal: false, expiresAt: null, slots: [] }) });
    assert.deepEqual(res.body, { status: "turnedIn", turnedInInferred: true });
    const book = (await call(env, "GET", "/api/v1/wondrous-tails", { token: alice })).body.books[0];
    assert.deepEqual([book.status, book.newJournalAvailable, book.slots.length], ["turnedIn", false, 0]);
  });

  it("keeps one book per member (switching characters replaces it) and enforces character ownership", async () => {
    await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt() });
    const alt = wt({ character: { contentId: BOB, name: "Alice Alt", homeWorldId: 409, homeWorld: "Kraken" } });
    assert.equal((await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: alt })).status, 200);
    const books = (await call(env, "GET", "/api/v1/wondrous-tails", { token: alice })).body.books;
    assert.equal(books.filter((b: any) => b.member === "Alice").length, 1);
    assert.equal(books[0].character, "Alice Alt");

    const bob = await addMember(env, "Bobby");
    assert.equal((await call(env, "POST", "/api/v1/wondrous-tails", { token: bob, body: wt() })).status, 403, "Alice's character");
  });

  it("ignores out-of-order uploads", async () => {
    await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ stickersPlaced: 5 }) });
    const old = await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ stickersPlaced: 1, capturedAt: new Date(Date.now() - 3_600_000).toISOString() }) });
    assert.equal(old.body.status, "stale");
    assert.equal((await call(env, "GET", "/api/v1/wondrous-tails", { token: alice })).body.books[0].stickersPlaced, 5);
  });

  it("validates uploads and only accepts the bearer key for writes", async () => {
    const bad = await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ slots: slots().slice(0, 3) }) });
    assert.equal(bad.status, 422);
    const noJournalWithSlots = await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: wt({ hasJournal: false, expiresAt: null }) });
    assert.equal(noJournalWithSlots.status, 422);

    const session = await handle(
      new Request("https://hub.test/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: alice }) }),
      env,
    );
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal((await call(env, "POST", "/api/v1/wondrous-tails", { headers: { cookie }, body: wt() })).status, 401);
    assert.equal((await call(env, "GET", "/api/v1/wondrous-tails", { headers: { cookie } })).status, 200);
  });
});
