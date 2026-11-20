import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import type { UploadItem } from "../src/contract.ts";
import { ALICE, addMember, call, createEnv, FC, item, upload } from "./helpers.ts";
import { preflightSql } from "./preflight.ts";

type Env = ReturnType<typeof createEnv>;

interface StoredRow {
  rid: number;
  item_id: number;
  quantity: number;
  sorted_slot: number;
}

function rows(env: Env, ownerId: string, section: string): StoredRow[] {
  return env.DB.raw
    .prepare("SELECT rowid AS rid, item_id, quantity, sorted_slot FROM items WHERE owner_id = ? AND section = ? ORDER BY sorted_slot, rowid")
    .all(ownerId, section) as unknown as StoredRow[];
}

/** Rows inserted, updated or deleted on this connection so far (SQLite's own counter). */
function totalChanges(env: Env): number {
  return Number((env.DB.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
}

/** A full 140-slot inventory: one distinct stack per slot. */
function bag(overrides: Record<number, Partial<UploadItem>> = {}): UploadItem[] {
  return Array.from({ length: 140 }, (_, slot) =>
    item(2000 + slot, `Item ${slot}`, 10, `Inventory · slot ${slot + 1}`, { sortedSlot: slot, ...overrides[slot] }),
  );
}

let env: Env;
let key: string;
let clock: number;

async function send(section: string, items: UploadItem[], ownerId = ALICE, kind: "character" | "freeCompany" = "character") {
  clock += 1_000;
  const body = upload(ALICE, "Alice Example", [{ ownerId, kind, name: null, sections: [{ section, items }] }], new Date(clock).toISOString());
  const before = totalChanges(env);
  const res = await call(env, "POST", "/api/v1/snapshots", { token: key, body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return totalChanges(env) - before;
}

beforeEach(async () => {
  env = createEnv();
  key = await addMember(env, "Alice");
  clock = Date.parse("2026-11-20T12:00:00Z");
});

describe("section ingest writes only what changed", () => {
  test("one changed stack in a full bag rewrites one row, not 140", async () => {
    await send("CharacterBags", bag());
    const before = rows(env, ALICE, "CharacterBags");
    assert.equal(before.length, 140);

    const changes = await send("CharacterBags", bag({ 5: { quantity: 11 } }));
    const after = rows(env, ALICE, "CharacterBags");

    assert.equal(after.length, 140);
    assert.equal(after.find((r) => r.sorted_slot === 5)?.quantity, 11);
    const kept = after.filter((r) => before.some((b) => b.rid === r.rid));
    assert.equal(kept.length, 139, "untouched stacks keep their rows");
    // 2 item rows (delete + insert) plus the character, owner and owner_sections upserts.
    assert.ok(changes <= 5, `expected at most 5 row changes, got ${changes}`);
  });

  test("an identical re-upload writes no item rows", async () => {
    await send("CharacterBags", bag());
    const before = rows(env, ALICE, "CharacterBags").map((r) => r.rid);
    const changes = await send("CharacterBags", bag());
    assert.deepEqual(rows(env, ALICE, "CharacterBags").map((r) => r.rid), before);
    assert.ok(changes <= 3, `expected only metadata upserts, got ${changes}`);
  });

  test("moving a stack to another slot replaces just that row", async () => {
    await send("CharacterBags", bag());
    const changes = await send("CharacterBags", bag({ 0: { sortedSlot: 999 } }));
    const after = rows(env, ALICE, "CharacterBags");
    assert.equal(after.length, 140);
    assert.ok(after.some((r) => r.item_id === 2000 && r.sorted_slot === 999));
    assert.ok(changes <= 5, `got ${changes}`);
  });

  test("identical stacks are counted, not collapsed", async () => {
    const potion = (n: number) => Array.from({ length: n }, () => item(4554, "Cordial", 99, "Inventory · slot 1"));

    await send("CharacterBags", potion(3));
    assert.equal(rows(env, ALICE, "CharacterBags").length, 3);

    const shrink = await send("CharacterBags", potion(2));
    assert.equal(rows(env, ALICE, "CharacterBags").length, 2);
    assert.ok(shrink <= 4, `removing one of three identical stacks: got ${shrink}`);

    await send("CharacterBags", potion(4));
    assert.equal(rows(env, ALICE, "CharacterBags").length, 4);
  });

  test("an empty section clears it", async () => {
    await send("CharacterBags", bag());
    await send("CharacterBags", []);
    assert.equal(rows(env, ALICE, "CharacterBags").length, 0);
  });

  test("other sections are left alone", async () => {
    await send("CharacterBags", bag());
    await send("Crystals", [item(2, "Fire Shard", 999, "Crystals")]);
    assert.equal(rows(env, ALICE, "CharacterBags").length, 140);
    assert.equal(rows(env, ALICE, "Crystals").length, 1);
  });

  test("a shared FC chest converges when two uploads alternate", async () => {
    const chest = (qty: number) => [item(80, "Company Credits", qty, "FC chest · slot 1", { container: 2502, sortedContainer: 2502 })];
    await send("FreeCompanyBags", chest(100), FC, "freeCompany");
    await send("FreeCompanyBags", chest(200), FC, "freeCompany");
    await send("FreeCompanyBags", chest(100), FC, "freeCompany");
    const after = rows(env, FC, "FreeCompanyBags");
    assert.deepEqual(after.map((r) => r.quantity), [100]);
  });

  test("oversized sections fall back to replace-all and still store everything", async () => {
    const longText = "x".repeat(190);
    const huge = Array.from({ length: 3_000 }, (_, i) => item(i + 1, longText, 1, `${longText}${i}`, { sortedSlot: i }));
    await send("HousingInteriorItems", huge, ALICE);
    assert.equal(rows(env, ALICE, "HousingInteriorItems").length, 3_000);

    huge[0] = { ...huge[0]!, quantity: 2 };
    await send("HousingInteriorItems", huge, ALICE);
    const after = rows(env, ALICE, "HousingInteriorItems");
    assert.equal(after.length, 3_000);
    assert.equal(after.find((r) => r.item_id === 1)?.quantity, 2);
  });
});

describe("D1 preflight script", () => {
  const path = join(import.meta.dirname, "..", "scripts", "preflight-diff-ingest.sql");

  test("matches the SQL the server runs", () => {
    assert.equal(readFileSync(path, "utf8"), preflightSql(), "regenerate scripts/preflight-diff-ingest.sql from test/preflight.ts");
  });

  test("runs cleanly and writes nothing", async () => {
    await send("CharacterBags", bag());
    const before = totalChanges(env);
    env.DB.raw.exec(readFileSync(path, "utf8"));
    assert.equal(totalChanges(env), before);
    assert.equal(rows(env, ALICE, "CharacterBags").length, 140);
  });
});
