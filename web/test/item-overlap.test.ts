import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { commonItems, compactPlaces, expandPlaces, type ItemPlace, otherPlaces, type PlacedItem } from "../src/item-overlap.ts";
import { ADMIN_TOKEN, ALICE, ALICE_RETAINER, addMember, BOB, call, createEnv, FC, item, upload } from "./helpers.ts";

const IRON_ORE = 5111;
const POTION = 4551;
const SHARD = 2;

/**
 * Alice: Iron Ore in her bags (two stacks), her retainer's bags, and a market listing.
 * Bob: Iron Ore and an HQ Potion in his saddlebag; Alice's Potion is NQ.
 * FC chest (reported by Bob): Iron Ore. Everyone has Fire Shards (crystals, left out).
 */
describe("items in common / also in", () => {
  let env: ReturnType<typeof createEnv>;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    env = createEnv();
    alice = await addMember(env, "Alice");
    bob = await addMember(env, "Bob");
    await call(env, "POST", "/api/v1/snapshots", {
      token: alice,
      body: upload(ALICE, "Alice Example", [
        {
          ownerId: ALICE,
          kind: "character",
          name: "Alice Example",
          sections: [
            {
              section: "CharacterBags",
              items: [
                item(IRON_ORE, "Iron Ore", 10, "Inventory · bag 1 · slot 1"),
                item(IRON_ORE, "Iron Ore", 5, "Inventory · bag 1 · slot 2", { sortedSlot: 1 }),
                item(POTION, "Potion", 3, "Inventory · bag 1 · slot 3", { sortedSlot: 2 }),
              ],
            },
            { section: "Crystals", items: [item(SHARD, "Fire Shard", 900, "Crystals · Fire Shard")] },
          ],
        },
        {
          ownerId: ALICE_RETAINER,
          kind: "retainer",
          name: "Sir-noodle",
          sections: [
            { section: "RetainerBags", items: [item(IRON_ORE, "Iron Ore", 99, "Retainer · page 1 · slot 1")] },
            { section: "RetainerMarket", items: [item(IRON_ORE, "Iron Ore", 20, "Retainer (market) · slot 1")] },
          ],
        },
      ]),
    });
    await call(env, "POST", "/api/v1/snapshots", {
      token: bob,
      body: upload(BOB, "Bob Example", [
        {
          ownerId: BOB,
          kind: "character",
          name: "Bob Example",
          sections: [
            {
              section: "CharacterSaddleBags",
              items: [
                item(IRON_ORE, "Iron Ore", 7, "Saddlebag · page 1 · slot 1"),
                item(POTION, "Potion", 2, "Saddlebag · page 1 · slot 2", { isHq: true, sortedSlot: 1 }),
              ],
            },
            { section: "Crystals", items: [item(SHARD, "Fire Shard", 300, "Crystals · Fire Shard")] },
          ],
        },
        {
          ownerId: FC,
          kind: "freeCompany",
          name: "Example FC",
          sections: [{ section: "FreeCompanyBags", items: [item(IRON_ORE, "Iron Ore", 999, "FC chest · tab 1 · slot 1")] }],
        },
      ]),
    });
  });

  it("lists every storage place of an owner's items, stacks added up", async () => {
    const res = await call(env, "GET", `/api/v1/owners/${ALICE}/also-in`, { token: alice });
    assert.equal(res.status, 200);
    const items = expandPlaces(res.body);
    const ore = items.find((i) => i.itemId === IRON_ORE)!;
    assert.deepEqual(
      ore.places.map((p: ItemPlace) => [p.member, p.ownerKind, p.section, p.quantity, p.stacks]),
      [
        ["Alice", "character", "CharacterBags", 15, 2],
        ["Alice", "retainer", "RetainerBags", 99, 1],
        ["Bob", "character", "CharacterSaddleBags", 7, 1],
        ["Bob", "freeCompany", "FreeCompanyBags", 999, 1],
      ],
      "market listings aren't storage",
    );
    assert.equal(ore.places[1]!.ownerName, "Sir-noodle");
    assert.deepEqual(
      otherPlaces(ore.places, ALICE, "CharacterBags").map((p: ItemPlace) => p.section),
      ["RetainerBags", "CharacterSaddleBags", "FreeCompanyBags"],
    );

    // NQ and HQ don't stack, so Bob's HQ potion isn't another place for Alice's NQ one.
    const potions = items.filter((i) => i.itemId === POTION);
    assert.deepEqual(
      potions.map((i: PlacedItem) => [i.isHq, i.places.length]),
      [[false, 1]],
    );
    assert.equal(
      items.some((i) => i.itemId === SHARD),
      false,
      "crystals are left out",
    );
  });

  it("returns holders and the items two or more of them store", async () => {
    const res = await call(env, "GET", "/api/v1/items/in-common", { token: bob });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.holders.map((h: { label: string; kind: string }) => [h.label, h.kind]),
      [
        ["Alice", "member"],
        ["Bob", "member"],
        ["FC chest", "shared"],
      ],
    );
    assert.deepEqual(
      expandPlaces(res.body).map((i) => i.name),
      ["Iron Ore"],
      "potions differ in quality; shards are crystals",
    );
  });

  it("narrows to the chosen party, grouping each member's places", async () => {
    const { body } = await call(env, "GET", "/api/v1/items/in-common", { token: alice });
    const key = (label: string) => body.holders.find((h: { label: string }) => h.label === label).key as string;
    const items = expandPlaces(body);

    const all = commonItems(items, new Set([key("Alice"), key("Bob"), key("FC chest")]));
    assert.equal(all.length, 1);
    assert.equal(all[0]!.totalQuantity, 15 + 99 + 7 + 999);
    assert.deepEqual(
      all[0]!.holders.map((h) => [h.label, h.quantity, h.places.length]),
      [
        ["FC chest", 999, 1],
        ["Alice", 114, 2],
        ["Bob", 7, 1],
      ],
    );

    assert.deepEqual(
      commonItems(items, new Set([key("Alice"), key("FC chest")]))[0]!.holders.map((h) => h.label),
      ["FC chest", "Alice"],
    );
    assert.deepEqual(commonItems(items, new Set([key("Alice")])), [], "one holder alone has nothing in common");
  });

  it("validates the owner id and requires sign-in", async () => {
    assert.equal((await call(env, "GET", `/api/v1/owners/${ALICE}/also-in`)).status, 401);
    assert.equal((await call(env, "GET", "/api/v1/items/in-common")).status, 401);
    assert.equal((await call(env, "GET", "/api/v1/owners/abc/also-in", { token: alice })).status, 400);
    const unknown = await call(env, "GET", "/api/v1/owners/123/also-in", { token: alice });
    assert.deepEqual([unknown.status, unknown.body], [200, { sections: [], items: [] }]);
  });

  it("leaves out revoked members", async () => {
    assert.equal((await call(env, "POST", "/api/v1/admin/members/2/revoke", { token: ADMIN_TOKEN })).status, 200);
    const res = await call(env, "GET", "/api/v1/items/in-common", { token: alice });
    // Bob's character and the FC chest he reported both drop out, leaving Alice alone.
    assert.deepEqual(
      res.body.holders.map((h: { label: string }) => h.label),
      ["Alice"],
    );
    assert.deepEqual(res.body.items, []);
  });

  it("sends each section once and expands back to the same places", async () => {
    const res = await call(env, "GET", `/api/v1/owners/${ALICE}/also-in`, { token: alice });
    const keys = res.body.sections.map((s: ItemPlace) => `${s.ownerId}/${s.section}`);
    assert.equal(new Set(keys).size, keys.length, "no section repeated");
    const items: PlacedItem[] = expandPlaces(res.body);
    assert.deepEqual(expandPlaces(compactPlaces(items)), items, "round trip");
  });
});
