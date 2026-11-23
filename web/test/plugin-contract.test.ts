import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ALICE, ALICE_RETAINER, addMember, call, createEnv, item, upload } from "./helpers.ts";

/**
 * The exact JSON the C# plugin sends, and the JSON it reads back. plugin/FcHub.Tests serializes the
 * same payloads and parses the same responses, so the plugin and the server can't drift apart
 * without a test failing.
 */
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

describe("plugin contract", () => {
  it("accepts the plugin's inventory upload (schema v2)", async () => {
    const env = createEnv();
    const key = await addMember(env, "Alice");
    const res = await call(env, "POST", "/api/v1/snapshots", { token: key, body: fixture("plugin-upload-v2.json") });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { sectionsWritten: 4, itemsWritten: 3, sectionsSkippedStale: [], ownersRejected: [] });

    // The FC chest carries a sighting (ADR 0008); the plugin sends null for everything else.
    const chest = await call(env, "GET", "/api/v1/owners/9280933600000000001/items", { token: key });
    assert.equal(chest.body.sections[0].observedAt, "2026-11-20T18:15:00.000Z");
    const self = await call(env, "GET", "/api/v1/owners/18014498500000001/items", { token: key });
    assert.ok(self.body.sections.every((s: { observedAt: string | null }) => s.observedAt === null));
  });

  it("still accepts uploads from plugins that predate observedAt", async () => {
    const env = createEnv();
    const key = await addMember(env, "Alice");
    const old = fixture("plugin-upload-v2.json");
    for (const owner of old.owners) for (const section of owner.sections) delete section.observedAt;
    const res = await call(env, "POST", "/api/v1/snapshots", { token: key, body: old });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sectionsWritten, 4);
  });

  it("accepts the plugin's Wondrous Tails upload (schema v1)", async () => {
    const env = createEnv();
    const key = await addMember(env, "Alice");
    const res = await call(env, "POST", "/api/v1/wondrous-tails", { token: key, body: fixture("plugin-wondrous-tails-v1.json") });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { body } = await call(env, "GET", "/api/v1/wondrous-tails", { token: key });
    const [book] = body.books;
    assert.equal(book.character, "Alice Example");
    assert.equal(book.stickersPlaced, 3);
    assert.equal(book.secondChancePoints, 2);
    assert.equal(book.expiresAt, "2026-12-01T08:00:00.000Z");
    assert.equal(book.slots.length, 16);
    assert.deepEqual(
      book.slots.slice(0, 5).map((s: { name: string; status: string }) => [s.name, s.status]),
      [
        ["Objective 1", "claimed"],
        ["Objective 2", "claimed"],
        ["Objective 3", "claimed"],
        ["Objective 4", "claimable"],
        ["Objective 5", "open"],
      ],
    );
  });

  it("answers the plugin's tooltip request with the holdings it parses (fc-holdings v1)", async () => {
    const env = createEnv();
    const alice = await addMember(env, "Alice");
    const bob = await addMember(env, "Bob");
    const capturedAt = "2026-11-20T18:20:42.000Z";
    await call(env, "POST", "/api/v1/snapshots", {
      token: alice,
      body: upload(
        ALICE,
        "Alice Example",
        [
          {
            ownerId: ALICE,
            kind: "character",
            name: "Alice Example",
            sections: [
              {
                section: "CharacterBags",
                items: [
                  item(4554, "Cordial", 17, "Inventory · bag 1 · slot 2"),
                  item(4554, "Cordial", 2, "Inventory · bag 1 · slot 3", { isHq: true, sortedSlot: 1 }),
                ],
              },
              { section: "Crystals", items: [item(2, "Fire Shard", 900, "Crystals")] },
            ],
          },
          {
            ownerId: ALICE_RETAINER,
            kind: "retainer",
            name: "Sir-noodle",
            sections: [{ section: "RetainerBags", items: [item(4554, "Cordial", 40, "Retainer · page 1 · slot 1")] }],
          },
        ],
        capturedAt,
      ),
    });

    const res = await call(env, "GET", "/api/v1/items/fc-holdings", { token: bob });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, fixture("plugin-fc-holdings-v1.json"));
  });
});
