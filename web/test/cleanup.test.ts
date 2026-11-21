import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  ADMIN_TOKEN,
  ALICE,
  ALICE_RETAINER,
  addMember,
  BOB,
  call,
  createEnv,
  FC,
  item,
  type TestEnv,
  totalChanges,
  upload,
} from "./helpers.ts";

const HOUSE = "86131342900265472";
const BOB_RETAINER = "33777097200000002";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const ore = (qty: number) => [item(5111, "Iron Ore", qty, "slot 1")];

describe("admin cleanup", () => {
  let env: TestEnv;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    env = createEnv();
    alice = await addMember(env, "Alice");
    bob = await addMember(env, "Bob");
    // Alice: her character, a retainer, the FC chest, and the house's furnishings.
    await call(env, "POST", "/api/v1/snapshots", {
      token: alice,
      body: upload(ALICE, "Alice Example", [
        { ownerId: ALICE, kind: "character", name: null, sections: [{ section: "CharacterBags", items: ore(1) }] },
        { ownerId: ALICE_RETAINER, kind: "retainer", name: "Sir-noodle", sections: [{ section: "RetainerBags", items: ore(2) }] },
        { ownerId: FC, kind: "freeCompany", name: "Example FC", sections: [{ section: "FreeCompanyBags", items: ore(3) }] },
        { ownerId: HOUSE, kind: "housing", name: "Plot 51", sections: [{ section: "HousingInteriorItems", items: ore(4) }] },
      ]),
    });
    // Bob: his character, a retainer last seen 200 days ago, and the house's storeroom.
    await call(env, "POST", "/api/v1/snapshots", {
      token: bob,
      body: upload(
        BOB,
        "Bob Example",
        [{ ownerId: BOB_RETAINER, kind: "retainer", name: "Old-timer", sections: [{ section: "RetainerBags", items: ore(5) }] }],
        daysAgo(200),
      ),
    });
    await call(env, "POST", "/api/v1/snapshots", {
      token: bob,
      body: upload(BOB, "Bob Example", [
        { ownerId: BOB, kind: "character", name: null, sections: [{ section: "CharacterBags", items: ore(6) }] },
        { ownerId: HOUSE, kind: "housing", name: "Plot 51", sections: [{ section: "HousingInteriorStoreroom", items: ore(7) }] },
      ]),
    });
  });

  const rowCount = (table: string) => (env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("previews by default and changes nothing", async () => {
    await call(env, "POST", "/api/v1/admin/members/1/revoke", { token: ADMIN_TOKEN });
    const before = totalChanges(env);
    const res = await call(env, "POST", "/api/v1/admin/cleanup", { token: ADMIN_TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.deepEqual(res.body.revoked, { members: 1, characters: 1, owners: 3, sections: 4, items: 4, journals: 0 });
    assert.equal(totalChanges(env), before, "a dry run writes nothing");
    assert.equal((await call(env, "POST", "/api/v1/admin/cleanup", { token: bob })).status, 401, "admin only");
  });

  it("removes a revoked member's data, hands shared storage over, and frees their character", async () => {
    await call(env, "POST", "/api/v1/admin/members/1/revoke", { token: ADMIN_TOKEN });
    const res = await call(env, "POST", "/api/v1/admin/cleanup", { token: ADMIN_TOKEN, body: { dryRun: false } });
    assert.equal(res.body.dryRun, false);

    const owners = env.DB.raw.prepare("SELECT owner_id, reported_by FROM owners ORDER BY owner_id").all() as {
      owner_id: string;
      reported_by: string;
    }[];
    assert.deepEqual(
      owners.map((o) => [o.owner_id, o.reported_by]),
      [
        [BOB, BOB],
        [BOB_RETAINER, BOB],
        [HOUSE, BOB], // Alice's furnishings went; Bob's storeroom keeps the house, now his.
      ],
    );
    assert.equal(rowCount("owner_sections"), 3);
    assert.equal(rowCount("items"), 3);
    assert.deepEqual(
      env.DB.raw
        .prepare("SELECT name FROM characters")
        .all()
        .map((r) => (r as { name: string }).name),
      ["Bob Example"],
    );

    // Alice's character is free to be registered again (e.g. she rejoins with a new key).
    const rejoined = await addMember(env, "Alice again");
    const again = await call(env, "POST", "/api/v1/snapshots", {
      token: rejoined,
      body: upload(ALICE, "Alice Example", [{ ownerId: ALICE, kind: "character", name: null, sections: [] }]),
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });

  it("clears expired sessions and usage rows older than 90 days", async () => {
    env.DB.raw.prepare("INSERT INTO sessions VALUES ('old', 2, ?, ?)").run(daysAgo(40), daysAgo(10));
    env.DB.raw.prepare("INSERT INTO usage_daily VALUES (?, 2, 100, 1)").run(daysAgo(120).slice(0, 10));
    const res = await call(env, "POST", "/api/v1/admin/cleanup", { token: ADMIN_TOKEN, body: { dryRun: false } });
    assert.equal(res.body.expiredSessions, 1);
    assert.equal(res.body.usageRowsOlderThan90Days, 1);
    assert.equal(rowCount("sessions"), 0);
    assert.equal(
      (env.DB.raw.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE day < ?").get(daysAgo(90).slice(0, 10)) as { n: number }).n,
      0,
    );
  });

  it("lists owners not seen for a while, and deletes one on request", async () => {
    assert.equal((await call(env, "GET", "/api/v1/admin/stale-owners", { token: bob })).status, 401);
    assert.equal((await call(env, "GET", "/api/v1/admin/stale-owners?days=0", { token: ADMIN_TOKEN })).status, 400);

    const stale = await call(env, "GET", "/api/v1/admin/stale-owners?days=180", { token: ADMIN_TOKEN });
    assert.deepEqual(
      stale.body.owners.map((o: { ownerId: string; name: string; member: string; items: number }) => [
        o.ownerId,
        o.name,
        o.member,
        o.items,
      ]),
      [[BOB_RETAINER, "Old-timer", "Bob", 1]],
    );

    const deleted = await call(env, "DELETE", `/api/v1/admin/owners/${BOB_RETAINER}`, { token: ADMIN_TOKEN });
    assert.deepEqual(deleted.body, { ownerId: BOB_RETAINER, sections: 1, items: 1 });
    assert.equal((await call(env, "DELETE", `/api/v1/admin/owners/${BOB_RETAINER}`, { token: ADMIN_TOKEN })).status, 404);
    assert.deepEqual((await call(env, "GET", "/api/v1/admin/stale-owners?days=180", { token: ADMIN_TOKEN })).body.owners, []);
  });
});
