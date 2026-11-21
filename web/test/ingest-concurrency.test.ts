import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { Member } from "../src/auth.ts";
import type { UploadItem } from "../src/contract.ts";
import { HttpError } from "../src/http-error.ts";
import { ingestUpload } from "../src/ingest.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import type { WtUpload } from "../src/wondrous-tails.ts";
import { saveWondrousTails } from "../src/wondrous-tails-store.ts";
import { ALICE, ALICE_RETAINER, addMember, BOB, createEnv, FC, item, type TestEnv, upload, withRoundTrips } from "./helpers.ts";

/**
 * Two uploads in flight at once, with D1's round trips between each request's reads and its batch
 * (see withRoundTrips). Whichever request starts first reaches its batch first, so each test picks
 * the commit order by the order it starts them in.
 */

const OLDER = "2026-11-20T12:00:00.000Z";
const NEWER = "2026-11-20T12:00:05.000Z";
const NOW = new Date("2026-11-20T12:01:00.000Z");

const alice: Member = { id: 1, displayName: "Alice" };
const bob: Member = { id: 2, displayName: "Bob" };

let env: TestEnv;

beforeEach(async () => {
  env = createEnv();
  await addMember(env, "Alice");
  await addMember(env, "Bob");
});

function chestUpload(contentId: string, items: UploadItem[], capturedAt: string) {
  return upload(
    contentId,
    contentId,
    [{ ownerId: FC, kind: "freeCompany", name: null, sections: [{ section: "FreeCompanyBags", items }] }],
    capturedAt,
  );
}

const credits = (qty: number) => [item(80, "Company Credits", qty, "FC chest · slot 1", { container: 20000, sortedContainer: 20000 })];

function stored(ownerId: string, section: string) {
  const row = env.DB.raw
    .prepare("SELECT captured_at, reported_by FROM owner_sections WHERE owner_id = ? AND section = ?")
    .get(ownerId, section) as { captured_at: string; reported_by: string } | undefined;
  const items = env.DB.raw
    .prepare("SELECT item_id, quantity FROM items WHERE owner_id = ? AND section = ? ORDER BY rowid")
    .all(ownerId, section) as {
    item_id: number;
    quantity: number;
  }[];
  return { capturedAt: row?.captured_at, reportedBy: row?.reported_by, items };
}

function rejectedWith(status: number) {
  return (error: unknown) => error instanceof HttpError && error.status === status;
}

describe("concurrent uploads of a shared section", () => {
  test("an older report that commits last doesn't replace a newer one", async () => {
    const db = withRoundTrips(env.DB);
    const [newer, older] = await Promise.all([
      ingestUpload(db, bob, chestUpload(BOB, credits(200), NEWER), DEFAULT_LIMITS, NOW),
      ingestUpload(db, alice, chestUpload(ALICE, credits(100), OLDER), DEFAULT_LIMITS, NOW),
    ]);

    const chest = stored(FC, "FreeCompanyBags");
    assert.deepEqual(
      chest.items.map((r) => r.quantity),
      [200],
    );
    assert.equal(chest.capturedAt, NEWER, "the section's time never goes backwards");
    assert.equal(chest.reportedBy, BOB);
    assert.equal(newer.sectionsWritten, 1);
    assert.deepEqual(older, { sectionsWritten: 0, itemsWritten: 0, sectionsSkippedStale: [`${FC}/FreeCompanyBags`], ownersRejected: [] });
  });

  test("a newer report that commits last replaces an older one", async () => {
    const db = withRoundTrips(env.DB);
    await Promise.all([
      ingestUpload(db, alice, chestUpload(ALICE, credits(100), OLDER), DEFAULT_LIMITS, NOW),
      ingestUpload(db, bob, chestUpload(BOB, credits(200), NEWER), DEFAULT_LIMITS, NOW),
    ]);

    const chest = stored(FC, "FreeCompanyBags");
    assert.deepEqual(
      chest.items.map((r) => r.quantity),
      [200],
    );
    assert.equal(chest.capturedAt, NEWER);
  });

  test("an oversized section (replace-all fallback) keeps the newer report too", async () => {
    // Long names push the packed JSON past the diff path's limit (see the fallback test in ingest.test.ts).
    const huge = (qty: number) =>
      Array.from({ length: DEFAULT_LIMITS.itemsPerSection }, (_, i) =>
        item(10_000 + i, `${"x".repeat(190)} ${i}`, qty, `FC chest · slot ${i + 1}`, { sortedSlot: i, container: 20000 }),
      );
    const db = withRoundTrips(env.DB);
    await Promise.all([
      ingestUpload(db, bob, chestUpload(BOB, huge(2), NEWER), DEFAULT_LIMITS, NOW),
      ingestUpload(db, alice, chestUpload(ALICE, huge(1), OLDER), DEFAULT_LIMITS, NOW),
    ]);

    const chest = stored(FC, "FreeCompanyBags");
    assert.equal(chest.items.length, DEFAULT_LIMITS.itemsPerSection);
    assert.ok(
      chest.items.every((r) => r.quantity === 2),
      "every stored stack is from the newer report",
    );
    assert.equal(chest.capturedAt, NEWER);
  });
});

describe("concurrent claims", () => {
  test("two members claiming a new character at once: the second gets 403 and writes nothing", async () => {
    const bag = (qty: number) =>
      upload(
        ALICE,
        "Alice",
        [
          {
            ownerId: ALICE,
            kind: "character",
            name: null,
            sections: [{ section: "CharacterBags", items: [item(5, "Thing", qty, "Inventory")] }],
          },
        ],
        OLDER,
      );
    const db = withRoundTrips(env.DB);
    const [first, second] = await Promise.allSettled([
      ingestUpload(db, alice, bag(1), DEFAULT_LIMITS, NOW),
      ingestUpload(db, bob, bag(999), DEFAULT_LIMITS, NOW),
    ]);

    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.ok(
      rejectedWith(403)(second.status === "rejected" ? second.reason : undefined),
      "the loser gets the same 403 as the up-front check",
    );
    assert.equal(
      (env.DB.raw.prepare("SELECT member_id FROM characters WHERE content_id = ?").get(ALICE) as { member_id: number }).member_id,
      alice.id,
    );
    assert.deepEqual(
      stored(ALICE, "CharacterBags").items.map((r) => r.quantity),
      [1],
      "only the claimant's items are stored",
    );
  });

  test("two members' Wondrous Tails uploads claiming a new character at once: the second gets 403", async () => {
    // Two journal uploads, so both make the same round trips and the first one started commits first.
    const journal: WtUpload = {
      schemaVersion: 1,
      pluginVersion: "test",
      capturedAt: OLDER,
      character: { contentId: ALICE, name: "Alice", homeWorldId: 409, homeWorld: "Kraken" },
      hasJournal: false,
      isExpired: false,
      expiresAt: null,
      secondChancePoints: 0,
      stickersPlaced: 0,
      slots: [],
    };
    const db = withRoundTrips(env.DB);
    const [first, second] = await Promise.allSettled([
      saveWondrousTails(db, alice, journal, NOW),
      saveWondrousTails(db, bob, journal, NOW),
    ]);

    assert.equal(first.status, "fulfilled");
    assert.ok(second.status === "rejected" && rejectedWith(403)(second.reason));
    assert.deepEqual(
      env.DB.raw
        .prepare("SELECT member_id FROM wondrous_tails")
        .all()
        .map((r) => r.member_id),
      [alice.id],
      "only the claimant's journal is stored",
    );
  });

  test("two characters reporting the same new retainer at once: the second gets 409 and writes nothing", async () => {
    const retainer = (contentId: string, qty: number) =>
      upload(
        contentId,
        contentId,
        [
          {
            ownerId: ALICE_RETAINER,
            kind: "retainer",
            name: "Bobbin",
            sections: [{ section: "RetainerBags", items: [item(7, "Ore", qty, "Retainer")] }],
          },
        ],
        OLDER,
      );
    const db = withRoundTrips(env.DB);
    const [first, second] = await Promise.allSettled([
      ingestUpload(db, alice, retainer(ALICE, 1), DEFAULT_LIMITS, NOW),
      ingestUpload(db, bob, retainer(BOB, 999), DEFAULT_LIMITS, NOW),
    ]);

    assert.equal(first.status, "fulfilled");
    assert.ok(second.status === "rejected" && rejectedWith(409)(second.reason), "a retryable conflict, not a silent takeover");
    assert.equal(
      (env.DB.raw.prepare("SELECT reported_by FROM owners WHERE owner_id = ?").get(ALICE_RETAINER) as { reported_by: string }).reported_by,
      ALICE,
    );
    assert.deepEqual(
      stored(ALICE_RETAINER, "RetainerBags").items.map((r) => r.quantity),
      [1],
    );
    assert.equal(
      env.DB.raw.prepare("SELECT COUNT(*) AS n FROM characters WHERE content_id = ?").get(BOB)?.n,
      0,
      "the whole batch rolled back",
    );
  });
});
