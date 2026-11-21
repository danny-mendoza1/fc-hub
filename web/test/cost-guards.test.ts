import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { routeTable } from "../src/app.ts";
import { readOnly } from "../src/db/guards.ts";
import { DEFAULT_LIMITS, resolveLimits } from "../src/limits.ts";
import { ADMIN_TOKEN, ALICE, ALICE_RETAINER, addMember, BOB, call, createEnv, envWith, fakeIconFetch, item, send, type TestEnv, totalChanges, upload } from "./helpers.ts";

const aliceBags = (quantity = 10) =>
  upload(ALICE, "Alice Example", [
    {
      ownerId: ALICE,
      kind: "character",
      name: "Alice Example",
      sections: [{ section: "CharacterBags", items: [item(5111, "Iron Ore", quantity, "Inventory · bag 1 · slot 1")] }],
    },
  ]);

const bobBags = () =>
  upload(BOB, "Bob Example", [
    { ownerId: BOB, kind: "character", name: "Bob Example", sections: [{ section: "CharacterBags", items: [item(4551, "Potion", 1, "Inventory · bag 1 · slot 1")] }] },
  ]);

/** Example values for path parameters. A new route with a new parameter must add one here. */
const SAMPLE_PARAMS: Record<string, string> = { ownerId: ALICE, iconId: "1000", id: "1" };

describe("route policies", () => {
  it("every GET route is read-only: it runs, and writes nothing", async () => {
    const env = createEnv();
    env.FETCH = fakeIconFetch;
    const alice = await addMember(env, "Alice");
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags() });

    const gets = routeTable().filter((r) => r.method === "GET");
    assert.ok(gets.length >= 10, "expected the whole route table");
    for (const r of gets) {
      const path = r.path.replace(/:(\w+)/g, (_m, key: string) => {
        assert.ok(key in SAMPLE_PARAMS, `add a sample value for :${key} (route ${r.path}) to SAMPLE_PARAMS`);
        return SAMPLE_PARAMS[key]!;
      });
      const token = r.policy.access === "admin" ? ADMIN_TOKEN : r.policy.access === "public" ? undefined : alice;
      const before = totalChanges(env);
      const res = await send(env, "GET", path, { token });
      assert.ok(res.status < 500, `${r.path} failed with ${res.status}: ${await res.text()}`);
      assert.equal(totalChanges(env) - before, 0, `${r.path} wrote to the database`);
    }
  });

  it("only uploads are metered, only by API key, and only admin routes write unmetered", () => {
    for (const r of routeTable()) {
      if (r.method === "GET") assert.equal(r.policy.writes, "none", r.path);
      if (r.policy.writes === "metered") assert.equal(r.policy.access, "member", `${r.path}: cookies must never write`);
      if (r.policy.writes === "admin") assert.match(r.path, /^\/api\/v1\/admin\//, r.path);
    }
    const metered = routeTable().filter((r) => r.policy.writes === "metered").map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(metered.sort(), ["POST /api/v1/snapshots", "POST /api/v1/wondrous-tails"]);
  });

  it("the read-only database refuses writes but allows reads", async () => {
    const env = createEnv();
    const db = readOnly(env.DB);
    assert.equal((await db.prepare("SELECT 1 AS one").first<{ one: number }>())?.one, 1);
    assert.ok(await db.prepare("SELECT updated_at, last_upload_at FROM owners, characters LIMIT 1").all());
    for (const sql of ["INSERT INTO members VALUES (1)", "update members set display_name = 'x'", "DELETE FROM items", "DROP TABLE items"]) {
      assert.throws(() => db.prepare(sql), /read-only/, sql);
    }
    assert.throws(() => db.batch([]), /read-only/);
  });

  it("never sends the budget override to clients", async () => {
    const env = createEnv();
    const key = await addMember(env, "Alice");
    await call(env, "PUT", "/api/v1/admin/members/1/write-budget", { token: ADMIN_TOKEN, body: { dailyWriteRows: 5 } });
    const me = await call(env, "GET", "/api/v1/me", { token: key });
    assert.deepEqual(Object.keys(me.body.member).sort(), ["displayName", "id"]);
  });
});

describe("daily write budget", () => {
  it("records each upload's rows against the member and the day", async () => {
    const env = createEnv();
    const alice = await addMember(env, "Alice");
    const before = totalChanges(env);
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags() })).status, 200);
    const written = totalChanges(env) - before;

    const ledger = env.DB.raw.prepare("SELECT day, member_id, rows_written, requests FROM usage_daily").all() as Record<string, unknown>[];
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.day, new Date().toISOString().slice(0, 10));
    assert.equal(ledger[0]!.member_id, 1);
    assert.equal(ledger[0]!.requests, 1);
    assert.equal(ledger[0]!.rows_written, written, "the ledger counts what the upload wrote, itself included");

    // A rejected upload writes nothing, so it's not charged.
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: alice, body: { schemaVersion: 2 } })).status, 422);
    assert.equal((env.DB.raw.prepare("SELECT requests FROM usage_daily").get() as { requests: number }).requests, 1);
  });

  it("refuses a member's uploads once their budget is spent, with Retry-After until midnight UTC", async () => {
    const env = envWith({ LIMIT_MEMBER_DAILY_WRITE_ROWS: "3" });
    const alice = await addMember(env, "Alice");
    const bob = await addMember(env, "Bob");
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags(1) })).status, 200);

    const before = totalChanges(env);
    const refused = await refusedUpload(env, alice, aliceBags(2));
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.details.reason, "member");
    const retryAfter = Number(refused.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 86_400, `retry-after ${retryAfter}`);
    assert.equal(totalChanges(env), before, "a refused upload writes nothing");

    // Other members have their own budget.
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: bob, body: bobBags() })).status, 200);
  });

  it("stops everyone once the site budget is spent", async () => {
    const env = envWith({ LIMIT_SITE_DAILY_WRITE_ROWS: "3" });
    const alice = await addMember(env, "Alice");
    const bob = await addMember(env, "Bob");
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags() })).status, 200);
    const refused = await refusedUpload(env, bob, bobBags());
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.details.reason, "site");
  });

  it("covers Wondrous Tails uploads too", async () => {
    const env = envWith({ LIMIT_MEMBER_DAILY_WRITE_ROWS: "1" });
    const alice = await addMember(env, "Alice");
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags() });
    const res = await call(env, "POST", "/api/v1/wondrous-tails", { token: alice, body: { schemaVersion: 1 } });
    assert.equal(res.status, 429);
  });

  it("read-only mode refuses every upload and writes nothing", async () => {
    const env = envWith({ WRITES_ENABLED: "false" });
    const alice = await addMember(env, "Alice");
    const before = totalChanges(env);
    const res = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags() });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.details.reason, "disabled");
    assert.equal(totalChanges(env), before);
    // Reading still works.
    assert.equal((await call(env, "GET", "/api/v1/overview", { token: alice })).status, 200);
  });

  it("lets the admin raise one member's budget until a time, and clear it", async () => {
    const env = envWith({ LIMIT_MEMBER_DAILY_WRITE_ROWS: "3" });
    const alice = await addMember(env, "Alice");
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags(1) });
    assert.equal((await refusedUpload(env, alice, aliceBags(2))).status, 429);

    const budget = (body: unknown, token: string | null = ADMIN_TOKEN) =>
      call(env, "PUT", "/api/v1/admin/members/1/write-budget", { token: token ?? undefined, body });
    assert.equal((await budget({ dailyWriteRows: 1_000 }, null)).status, 401, "admin only");
    assert.equal((await budget({ dailyWriteRows: -1 })).status, 422);
    assert.equal((await budget({ dailyWriteRows: 1_000, until: "not a date" })).status, 422);
    assert.equal((await call(env, "PUT", "/api/v1/admin/members/99/write-budget", { token: ADMIN_TOKEN, body: { dailyWriteRows: 1 } })).status, 404);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    assert.deepEqual((await budget({ dailyWriteRows: 1_000, until: tomorrow })).body, { memberId: 1, dailyWriteRows: 1_000, until: tomorrow });
    assert.equal((await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags(2) })).status, 200);

    // An expired override no longer applies.
    await budget({ dailyWriteRows: 1_000, until: new Date(Date.now() - 1_000).toISOString() });
    assert.equal((await refusedUpload(env, alice, aliceBags(3))).status, 429);

    // Cleared: back to the site default.
    await budget({ dailyWriteRows: 1_000 });
    await budget({ dailyWriteRows: null });
    assert.equal((await refusedUpload(env, alice, aliceBags(4))).status, 429);
  });

  it("reports today's usage and the limits in force to the admin", async () => {
    const env = envWith({ LIMIT_ITEMS_PER_UPLOAD: "5000" });
    const alice = await addMember(env, "Alice");
    await addMember(env, "Bob");
    await call(env, "POST", "/api/v1/snapshots", { token: alice, body: aliceBags() });

    assert.equal((await call(env, "GET", "/api/v1/admin/usage", { token: alice })).status, 401);
    const { body } = await call(env, "GET", "/api/v1/admin/usage", { token: ADMIN_TOKEN });
    assert.equal(body.limits.itemsPerUpload, 5000);
    assert.equal(body.limits.memberDailyWriteRows, DEFAULT_LIMITS.memberDailyWriteRows);
    assert.deepEqual(
      body.members.map((m: { displayName: string; requests: number; budget: number }) => [m.displayName, m.requests, m.budget]),
      [
        ["Alice", 1, DEFAULT_LIMITS.memberDailyWriteRows],
        ["Bob", 0, DEFAULT_LIMITS.memberDailyWriteRows],
      ],
    );
    assert.ok(body.siteRowsWritten > 0 && body.siteRowsWritten === body.members[0].rowsWritten);
  });
});

describe("upload limits", () => {
  it("rejects uploads over the per-upload item limit, which an override can change", async () => {
    const env = envWith({ LIMIT_ITEMS_PER_UPLOAD: "2" });
    const alice = await addMember(env, "Alice");
    const three = upload(ALICE, "Alice Example", [
      {
        ownerId: ALICE,
        kind: "character",
        name: null,
        sections: [{ section: "CharacterBags", items: [1, 2, 3].map((i) => item(i, `Item ${i}`, 1, `slot ${i}`, { sortedSlot: i })) }],
      },
    ]);
    const res = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: three });
    assert.equal(res.status, 422);
    assert.match(res.body.error.details.join(" "), /at most 2 per upload/);
  });

  it("caps how many owners one character can create, without blocking known ones", async () => {
    const env = envWith({ LIMIT_OWNERS_PER_CHARACTER: "2" });
    const alice = await addMember(env, "Alice");
    const retainer = (ownerId: string, name: string) => ({
      ownerId,
      kind: "retainer" as const,
      name,
      sections: [{ section: "RetainerBags", items: [item(5111, "Iron Ore", 1, "Retainer · slot 1")] }],
    });
    const body = upload(ALICE, "Alice Example", [
      { ownerId: ALICE, kind: "character", name: null, sections: [{ section: "CharacterBags", items: [] }] },
      retainer(ALICE_RETAINER, "One"),
      retainer("33777097200000002", "Two"),
    ]);
    const first = await call(env, "POST", "/api/v1/snapshots", { token: alice, body });
    assert.deepEqual(first.body.ownersRejected, ["33777097200000002"]);

    // Owners it already has keep working; the cap only stops new ones.
    const again = await call(env, "POST", "/api/v1/snapshots", { token: alice, body: { ...body, capturedAt: new Date().toISOString() } });
    assert.deepEqual(again.body.ownersRejected, ["33777097200000002"]);
    assert.equal(again.body.sectionsWritten, 2);
  });

  it("ignores malformed overrides instead of switching a guard off", () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const limits = resolveLimits({ LIMIT_MEMBER_DAILY_WRITE_ROWS: "lots", LIMIT_SITE_DAILY_WRITE_ROWS: "0", LIMIT_ITEMS_PER_UPLOAD: "1_500" });
      assert.equal(limits.memberDailyWriteRows, DEFAULT_LIMITS.memberDailyWriteRows);
      assert.equal(limits.siteDailyWriteRows, DEFAULT_LIMITS.siteDailyWriteRows);
      assert.equal(limits.itemsPerUpload, 1_500);
    } finally {
      console.warn = warn;
    }
    assert.equal(resolveLimits({ WRITES_ENABLED: "false" }).writesEnabled, false);
    assert.equal(resolveLimits({ WRITES_ENABLED: false }).writesEnabled, false);
    assert.equal(resolveLimits({ WRITES_ENABLED: "true" }).writesEnabled, true);
    assert.equal(resolveLimits({ LIMIT_MAX_BODY_BYTES: 1024 }).maxBodyBytes, 1024);
  });
});

describe("indexes", () => {
  it("items carry only the owner/section index (every index is paid for on every write)", () => {
    const env = createEnv();
    const indexes = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' AND sql IS NOT NULL").all() as { name: string }[];
    assert.deepEqual(indexes.map((i) => i.name), ["items_by_owner_section"]);
  });
});

/** Keeps the Retry-After header, which call() drops. */
async function refusedUpload(env: TestEnv, token: string, body: unknown) {
  const response = await send(env, "POST", "/api/v1/snapshots", { token, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
