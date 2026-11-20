import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, it } from "node:test";
import type { AppEnv } from "../src/app.ts";
import { ADMIN_TOKEN, ALICE, ALICE_RETAINER, BOB, FC, addMember, call, createEnv, item, upload } from "./helpers.ts";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("routing", () => {
  it("serves health and rejects unknown routes and methods", async () => {
    const env = createEnv();
    assert.equal((await call(env, "GET", "/healthz")).status, 200);
    assert.equal((await call(env, "GET", "/nope")).status, 404);
    assert.equal((await call(env, "DELETE", "/healthz")).status, 405);
  });
});

describe("members", () => {
  it("only lets the admin create members, and returns a prefixed key once", async () => {
    const env = createEnv();
    assert.equal((await call(env, "POST", "/api/v1/admin/members", { body: { displayName: "X" } })).status, 401);
    assert.equal((await call(env, "POST", "/api/v1/admin/members", { token: "wrong", body: { displayName: "X" } })).status, 401);

    const created = await call(env, "POST", "/api/v1/admin/members", { token: ADMIN_TOKEN, body: { displayName: "Danny" } });
    assert.equal(created.status, 201);
    assert.match(created.body.apiKey, /^fch_[A-Za-z0-9_-]{43}$/);

    const stored = await env.DB.prepare("SELECT key_hash FROM members").first<{ key_hash: string }>();
    assert.notEqual(stored?.key_hash, created.body.apiKey, "key must be stored hashed");

    const me = await call(env, "GET", "/api/v1/me", { token: created.body.apiKey });
    assert.equal(me.status, 200);
    assert.equal(me.body.member.displayName, "Danny");
  });

  it("disables admin endpoints when no admin token is configured", async () => {
    const env: AppEnv = { ...createEnv(), ADMIN_TOKEN: undefined };
    assert.equal((await call(env, "POST", "/api/v1/admin/members", { token: "", body: { displayName: "X" } })).status, 401);
  });

  it("rejects revoked keys", async () => {
    const env = createEnv();
    const key = await addMember(env, "Danny");
    assert.equal((await call(env, "POST", "/api/v1/admin/members/1/revoke", { token: ADMIN_TOKEN })).status, 200);
    assert.equal((await call(env, "GET", "/api/v1/me", { token: key })).status, 401);
  });
});

describe("uploads and search", () => {
  let env: ReturnType<typeof createEnv>;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    env = createEnv();
    alice = await addMember(env, "Alice");
    bob = await addMember(env, "Bob");
  });

  const aliceFull = (capturedAt?: string) =>
    upload(
      ALICE,
      "Alice Example",
      [
        {
          ownerId: ALICE,
          kind: "character",
          name: "Alice Example",
          sections: [
            { section: "CharacterBags", items: [item(5057, "Iron Ore", 99, "Inventory · bag 1 · slot 1"), item(5057, "Iron Ore", 12, "Inventory · bag 2 · slot 3")] },
            { section: "Crystals", items: [item(2, "Fire Shard", 4321, "Crystals")] },
          ],
        },
        {
          ownerId: ALICE_RETAINER,
          kind: "retainer",
          name: "Sir-noodle",
          sections: [{ section: "RetainerBags", items: [item(5057, "Iron Ore", 50, "Retainer · page 1 · slot 1"), item(36104, "Grade 5 Tincture of Strength", 35, "Retainer · page 1 · slot 2", { isHq: true })] }],
        },
        {
          ownerId: FC,
          kind: "freeCompany",
          name: "Sea of Stars",
          sections: [{ section: "FreeCompanyBags", items: [item(36104, "Grade 5 Tincture of Strength", 85, "FC chest · page 1 · slot 1", { isHq: true })] }],
        },
      ],
      capturedAt,
    );

  it("requires a member key to upload or search", async () => {
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { body: aliceFull() })).status, 401);
    assert.equal((await call(env, "GET", "/api/v1/search?q=ore")).status, 401);
  });

  it("validates uploads", async () => {
    const res = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: { schemaVersion: 1, owners: "nope" } });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.length > 0);

    const badId = aliceFull();
    badId.character.contentId = "12345678901234567890123"; // too long
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: alice, body: badId })).status, 422);
  });

  it("stores an upload and finds items grouped by item, quality and owner", async () => {
    const res = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceFull() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sectionsWritten: 4, itemsWritten: 6, sectionsSkippedStale: [], ownersRejected: [] });

    const search = await call(env, "GET", "/api/v1/search?q=IRON", { token: bob });
    assert.equal(search.status, 200);
    assert.equal(search.body.hits.length, 1);
    const ore = search.body.hits[0];
    assert.equal(ore.totalQuantity, 161);
    assert.deepEqual(
      ore.holdings.map((h: any) => [h.ownerKind, h.ownerName, h.quantity, h.locations.length, h.member]),
      [
        ["character", "Alice Example", 111, 2, "Alice"],
        ["retainer", "Sir-noodle", 50, 1, "Alice"],
      ],
    );

    const tincture = await call(env, "GET", "/api/v1/search?q=36104", { token: bob });
    assert.equal(tincture.body.hits.length, 1);
    assert.equal(tincture.body.hits[0].isHq, true);
    assert.equal(tincture.body.hits[0].totalQuantity, 120);
  });

  it("replaces only the sections that are sent, and clears sections sent empty", async () => {
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceFull(minutesAgo(10)) });

    const partial = upload(ALICE, "Alice Example", [
      { ownerId: ALICE, kind: "character", name: "Alice Example", sections: [{ section: "CharacterBags", items: [] }] },
    ]);
    const res = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: partial });
    assert.equal(res.body.sectionsWritten, 1);

    const ore = (await call(env, "GET", "/api/v1/search?q=iron ore", { token: alice })).body.hits[0];
    assert.deepEqual(ore.holdings.map((h: any) => h.ownerKind), ["retainer"], "bags cleared, retainer untouched");
    const shards = (await call(env, "GET", "/api/v1/search?q=fire shard", { token: alice })).body.hits;
    assert.equal(shards[0].totalQuantity, 4321, "crystals untouched");
  });

  it("skips sections when the server already has newer data", async () => {
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceFull() });
    const old = aliceFull(minutesAgo(60));
    old.owners = [old.owners[2]!]; // FC chest only
    const res = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: old });
    assert.deepEqual(res.body.sectionsSkippedStale, [`${FC}/FreeCompanyBags`]);
  });

  it("lets FC mates update the shared FC chest but not each other's characters or retainers", async () => {
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceFull(minutesAgo(5)) });

    // Bob can't claim Alice's character.
    const hijack = upload(ALICE, "Alice Example", []);
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: bob, body: hijack })).status, 403);

    // Bob's upload: his own character, a newer view of the FC chest, and (bogus) Alice's retainer.
    const bobUpload = upload(BOB, "Bob Example", [
      { ownerId: BOB, kind: "character", name: "Bob Example", sections: [{ section: "CharacterBags", items: [item(5057, "Iron Ore", 1, "Inventory · bag 1 · slot 1")] }] },
      { ownerId: FC, kind: "freeCompany", name: "Sea of Stars", sections: [{ section: "FreeCompanyBags", items: [] }] },
      { ownerId: ALICE_RETAINER, kind: "retainer", name: "Sir-noodle", sections: [{ section: "RetainerBags", items: [] }] },
    ]);
    const res = await call(env, "POST", "/api/v1/snapshots", { token: bob, body: bobUpload });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ownersRejected, [ALICE_RETAINER]);

    const tincture = (await call(env, "GET", "/api/v1/search?q=tincture", { token: bob })).body.hits[0];
    assert.deepEqual(tincture.holdings.map((h: any) => h.ownerKind), ["retainer"], "FC chest emptied by Bob, Alice's retainer intact");
  });

  it("accepts gzip bodies and rejects decompression bombs", async () => {
    const gz = gzipSync(JSON.stringify(aliceFull()));
    const ok = await call(env, "POST", "/api/v1/snapshots", {
      token: alice,
      rawBody: gz,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    assert.equal(ok.status, 200);

    const bomb = gzipSync(Buffer.alloc(9 * 1024 * 1024, 0x20));
    assert.ok(bomb.length < 64 * 1024);
    const res = await call(env, "POST", "/api/v1/snapshots", {
      token: alice,
      rawBody: bomb,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    assert.equal(res.status, 413);
  });

  it("limits search query length", async () => {
    const res = await call(env, "GET", `/api/v1/search?q=${"a".repeat(51)}`, { token: alice });
    assert.equal(res.status, 400);
  });

  it("reports per-section freshness in the overview", async () => {
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceFull() });
    const res = await call(env, "GET", "/api/v1/overview", { token: bob });
    assert.equal(res.status, 200);
    const [character] = res.body.characters;
    assert.equal(character.name, "Alice Example");
    assert.deepEqual(
      character.owners.map((o: any) => [o.kind, o.sections.map((s: any) => `${s.section}:${s.itemCount}`).join(",")]),
      [
        ["character", "CharacterBags:2,Crystals:1"],
        ["freeCompany", "FreeCompanyBags:1"],
        ["retainer", "RetainerBags:2"],
      ],
    );
  });
});
