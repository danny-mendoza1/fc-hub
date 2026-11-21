import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addMember, call, createEnv } from "./helpers.ts";

/**
 * The exact JSON the C# plugin sends. plugin/FcHub.Tests serializes the same payloads and checks
 * they match these files, so the plugin and the server can't drift apart without a test failing.
 */
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

describe("plugin contract", () => {
  it("accepts the plugin's inventory upload (schema v2)", async () => {
    const env = createEnv();
    const key = await addMember(env, "Alice");
    const res = await call(env, "POST", "/api/v1/snapshots", { token: key, body: fixture("plugin-upload-v2.json") });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { sectionsWritten: 4, itemsWritten: 3, sectionsSkippedStale: [], ownersRejected: [] });
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
});
