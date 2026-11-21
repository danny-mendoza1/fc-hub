import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { Member } from "../src/auth.ts";
import { ingestUpload, replaces } from "../src/ingest.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { ALICE, addMember, BOB, call, createEnv, FC, item, type TestEnv, upload } from "./helpers.ts";

/**
 * Shared sections (FC chest, houses) rank a sighting in game above any report (ADR 0008). Allagan
 * Tools keeps contents between sessions, so a plugin re-sending its cache (fresh install, "Re-upload
 * everything", an alt, a retry) reports old contents with a new capturedAt.
 */

const T1 = "2026-11-20T12:00:01.000Z";
const T2 = "2026-11-20T12:00:02.000Z";
const T3 = "2026-11-20T12:00:03.000Z";
const T5 = "2026-11-20T12:00:05.000Z";
const T9 = "2026-11-20T12:00:09.000Z";
const NOW = new Date("2026-11-20T12:10:00.000Z");

const alice: Member = { id: 1, displayName: "Alice" };
const bob: Member = { id: 2, displayName: "Bob" };

let env: TestEnv;
let aliceKey: string;

beforeEach(async () => {
  env = createEnv();
  aliceKey = await addMember(env, "Alice");
  await addMember(env, "Bob");
});

function chest(contentId: string, qty: number, capturedAt: string, observedAt: string | null = null) {
  return upload(
    contentId,
    contentId,
    [
      {
        ownerId: FC,
        kind: "freeCompany",
        name: null,
        sections: [{ section: "FreeCompanyBags", items: [item(80, "Company Credits", qty, "FC chest · slot 1")], observedAt }],
      },
    ],
    capturedAt,
  );
}

const send = (member: Member, contentId: string, qty: number, capturedAt: string, observedAt: string | null = null) =>
  ingestUpload(env.DB, member, chest(contentId, qty, capturedAt, observedAt), DEFAULT_LIMITS, NOW);

function stored() {
  const row = env.DB.raw.prepare("SELECT captured_at, observed_at, reported_by FROM owner_sections WHERE owner_id = ?").get(FC) as {
    captured_at: string;
    observed_at: string | null;
    reported_by: string;
  };
  const quantities = (env.DB.raw.prepare("SELECT quantity FROM items WHERE owner_id = ?").all(FC) as { quantity: number }[]).map(
    (r) => r.quantity,
  );
  return { capturedAt: row.captured_at, observedAt: row.observed_at, reportedBy: row.reported_by, quantities };
}

describe("shared sections: sightings outrank reports", () => {
  test("a stale cache re-sent later doesn't replace a mate's sighting", async () => {
    // Bob saw the chest at T1. Alice re-uploads her cached view (e.g. a fresh install) at T9.
    await send(bob, BOB, 200, T1, T1);
    const result = await send(alice, ALICE, 100, T9);

    assert.deepEqual(stored(), { capturedAt: T1, observedAt: T1, reportedBy: BOB, quantities: [200] });
    assert.deepEqual(result.sectionsSkippedStale, [`${FC}/FreeCompanyBags`]);
  });

  test("an older sighting reported later doesn't replace a newer one", async () => {
    // Alice saw the chest at T1 on one character, then reports it from an alt at T9; Bob saw it at T3.
    await send(bob, BOB, 200, T3, T3);
    await send(alice, ALICE, 100, T9, T1);

    assert.deepEqual(stored().quantities, [200]);
    assert.equal(stored().observedAt, T3);
  });

  test("a newer sighting replaces an older one", async () => {
    await send(bob, BOB, 200, T1, T1);
    await send(alice, ALICE, 100, T3, T3);

    assert.deepEqual(stored(), { capturedAt: T3, observedAt: T3, reportedBy: ALICE, quantities: [100] });
  });

  test("a sighting replaces a report, even one reported later", async () => {
    // Nobody can say how old Alice's cached view is; Bob's is known to be from T2.
    await send(alice, ALICE, 100, T9);
    await send(bob, BOB, 200, T3, T2);

    assert.deepEqual(stored(), { capturedAt: T3, observedAt: T2, reportedBy: BOB, quantities: [200] });
  });

  test("reports without sightings keep last-report-wins (older plugins, private sections)", async () => {
    await send(alice, ALICE, 100, T1);
    await send(bob, BOB, 200, T5);
    const late = await send(alice, ALICE, 300, T3);

    assert.deepEqual(stored().quantities, [200]);
    assert.equal(late.sectionsWritten, 0);
  });

  test("a sighting can't be later than the snapshot reporting it", async () => {
    await send(alice, ALICE, 100, T3, T9);
    assert.equal(stored().observedAt, T3);
  });

  test("replaces() follows the same order as the SQL", () => {
    const r = (capturedAt: string, observedAt: string | null = null) => ({ capturedAt, observedAt });
    assert.equal(replaces(r(T9), r(T1, T1)), false, "report vs sighting");
    assert.equal(replaces(r(T1, T1), r(T9)), true, "sighting vs report");
    assert.equal(replaces(r(T9, T1), r(T3, T3)), false, "older sighting");
    assert.equal(replaces(r(T3, T3), r(T3, T3)), true, "same sighting");
    assert.equal(replaces(r(T5), r(T3)), true, "newer report");
    assert.equal(replaces(r(T3), r(T5)), false, "older report");
  });
});

describe("observedAt over HTTP", () => {
  test("must be an ISO timestamp when present", async () => {
    const bad = chest(ALICE, 1, T3, "yesterday");
    const res = await call(env, "POST", "/api/v1/snapshots", { token: aliceKey, body: bad });
    assert.equal(res.status, 422);
    assert.ok(
      res.body.error.details.some((e: string) => e.includes("observedAt must be an ISO timestamp")),
      JSON.stringify(res.body),
    );

    const ok = await call(env, "POST", "/api/v1/snapshots", { token: aliceKey, body: chest(ALICE, 1, T3, null) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("the owner's items say when a section was seen in game", async () => {
    const res = await call(env, "POST", "/api/v1/snapshots", { token: aliceKey, body: chest(ALICE, 5, T3, T2) });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const items = await call(env, "GET", `/api/v1/owners/${FC}/items`, { token: aliceKey });
    assert.equal(items.status, 200);
    assert.equal(items.body.sections[0].observedAt, T2);
    assert.equal(items.body.sections[0].capturedAt, T3);
  });
});
