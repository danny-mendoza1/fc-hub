/**
 * Performance baseline: seeds a realistic FC into in-memory SQLite and times every read route
 * through the real `handle()`, plus the upload diff for growing section sizes.
 *
 *   npm run bench            (build first if you want the static rows: npm run build)
 *
 * Times are local and leave out the network. On Workers every DB call is a round trip to D1, so
 * the "DB calls" column matters as much as the milliseconds.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type AppEnv, handle } from "../src/app.ts";
import { hashKey } from "../src/auth.ts";
import { applyMigrations } from "../src/db/migrate.ts";
import { NodeSqliteDatabase } from "../src/db/sqlite.ts";
import type { SqlDatabase, SqlStatement } from "../src/db/types.ts";
import { DELETE_REMOVED_SQL, INSERT_ADDED_SQL } from "../src/ingest.ts";
import { diskAssets } from "../src/static.ts";

const WEB = join(import.meta.dirname, "..");
const MEMBERS = 10;
const RETAINERS = 8;
const DISTINCT_ITEMS = 4000;
const RUNS = 30;

const db = new NodeSqliteDatabase(":memory:");
applyMigrations(db, join(WEB, "migrations"));

/** Counts DB calls: each is a network round trip to D1 in production. */
let dbCalls = 0;
const unwrap = new WeakMap<SqlStatement, SqlStatement>();
function call<T>(run: () => T): T {
  dbCalls++;
  return run();
}
function counted(inner: SqlStatement): SqlStatement {
  const statement = {
    bind: (...values: unknown[]) => counted(inner.bind(...(values as never[]))),
    first: () => call(() => inner.first()),
    all: () => call(() => inner.all()),
    run: () => call(() => inner.run()),
  } as unknown as SqlStatement;
  unwrap.set(statement, inner);
  return statement;
}
const countingDb: SqlDatabase = {
  prepare: (sql) => counted(db.prepare(sql)),
  batch: (statements) => call(() => db.batch(statements.map((s) => unwrap.get(s) ?? s))),
};

const dist = join(WEB, "dist");
const env: AppEnv = {
  DB: countingDb,
  FETCH: async () => new Response(new Uint8Array(4000), { headers: { "content-type": "image/png" } }),
  ...(existsSync(join(dist, "index.html")) ? { ASSETS: diskAssets(dist) } : {}),
};

// Deterministic pseudo-random data, so runs are comparable.
let seed = 1;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const words = ["Iron", "Cotton", "Tincture", "Grade", "Rarefied", "Maple"];
const items = (n: number) =>
  Array.from({ length: n }, (_, slot) => {
    const id = 1000 + rnd(DISTINCT_ITEMS);
    return {
      itemId: id,
      name: `Item ${words[id % words.length]} ${id}`,
      iconId: 20000 + (id % 3000),
      quantity: 1 + rnd(999),
      isHq: rnd(5) === 0,
      isCollectable: false,
      container: 0,
      sortedContainer: Math.floor(slot / 35),
      sortedSlot: slot % 35,
      location: `page ${Math.floor(slot / 35) + 1} slot ${(slot % 35) + 1}`,
    };
  });

const keys: string[] = [];
let itemRows = 0;
for (let m = 0; m < MEMBERS; m++) {
  const key = `fch_bench${m}`;
  keys.push(key);
  db.raw
    .prepare("INSERT INTO members (display_name, key_hash, created_at) VALUES (?, ?, ?)")
    .run(`Member ${m}`, await hashKey(key), new Date().toISOString());
  const contentId = String(18014498500000000n + BigInt(m));
  const owners: unknown[] = [
    {
      ownerId: contentId,
      kind: "character",
      name: `Char ${m}`,
      sections: [
        { section: "CharacterBags", items: items(140) },
        { section: "CharacterSaddleBags", items: items(70) },
        { section: "CharacterArmoryChest", items: items(350) },
        { section: "GlamourChest", items: items(400) },
        { section: "Crystals", items: items(18) },
      ],
    },
  ];
  for (let r = 0; r < RETAINERS; r++) {
    owners.push({
      ownerId: String(33777097200000000n + BigInt(m * 100 + r)),
      kind: "retainer",
      name: `Ret ${m}-${r}`,
      sections: [
        { section: "RetainerBags", items: items(175) },
        { section: "RetainerMarket", items: items(20) },
      ],
    });
  }
  if (m === 0) {
    owners.push({
      ownerId: "9000000000000001",
      kind: "freeCompany",
      name: "FC",
      sections: [{ section: "FreeCompanyBags", items: items(1250) }],
    });
  }
  itemRows += JSON.stringify(owners).split('"itemId"').length - 1;
  const res = await handle(
    new Request("http://bench.local/api/v1/snapshots", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        pluginVersion: "bench",
        capturedAt: new Date().toISOString(),
        character: { contentId, name: `Char ${m}`, homeWorldId: 409, homeWorld: "Kraken" },
        owners,
      }),
    }),
    env,
  );
  if (!res.ok) throw new Error(`seeding failed: ${res.status} ${await res.text()}`);
}

const login = await handle(
  new Request("http://bench.local/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: keys[0] }),
  }),
  env,
);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

const jsFile = existsSync(join(dist, "assets")) ? readdirSync(join(dist, "assets")).find((f) => f.endsWith(".js")) : undefined;
const paths = [
  "/api/v1/me",
  "/api/v1/overview",
  "/api/v1/search?q=iron",
  "/api/v1/search?q=1500",
  "/api/v1/owners/18014498500000000/items",
  "/api/v1/owners/18014498500000000/also-in",
  "/api/v1/owners/9000000000000001/also-in",
  "/api/v1/items/in-common",
  "/api/v1/wondrous-tails",
  "/api/v1/icons/21204",
  ...(env.ASSETS ? ["/", ...(jsFile ? [`/assets/${jsFile}`] : [])] : []),
];

console.log(`Seeded ${MEMBERS} members, ${itemRows} item rows.\n`);
console.log(
  `${"route".padEnd(44)}${"p50 ms".padStart(8)}${"p95 ms".padStart(8)}${"bytes".padStart(10)}${"gzip".padStart(9)}${"DB calls".padStart(10)}`,
);
for (const path of paths) {
  const times: number[] = [];
  let bytes = 0;
  let gzip = 0;
  let calls = 0;
  for (let i = 0; i < RUNS; i++) {
    dbCalls = 0;
    const start = performance.now();
    const res = await handle(new Request(`http://bench.local${path}`, { headers: { cookie } }), env);
    const body = new Uint8Array(await res.arrayBuffer());
    times.push(performance.now() - start);
    bytes = body.length;
    gzip = gzipSync(body).length;
    calls = dbCalls;
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => (times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0).toFixed(1);
  console.log(
    `${path.padEnd(44)}${pct(0.5).padStart(8)}${pct(0.95).padStart(8)}${String(bytes).padStart(10)}${String(gzip).padStart(9)}${String(calls).padStart(10)}`,
  );
}

// Upload diff: the DELETE + INSERT pair for one section, one stack changed vs half the section.
const raw = db.raw;
const now = new Date().toISOString();
const holder = "18014498500000000";
const pack = (n: number, bump: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, k) => [
      1000 + k,
      `Item ${k}`,
      20000 + k,
      1 + ((k * 7) % 999) + (k < bump ? 1 : 0),
      0,
      0,
      0,
      Math.floor(k / 35),
      k % 35,
      `slot ${k}`,
    ]),
  );
const del = raw.prepare(DELETE_REMOVED_SQL);
const ins = raw.prepare(INSERT_ADDED_SQL);
console.log(`\n${"upload diff: items".padEnd(24)}${"changed".padStart(9)}${"delete ms".padStart(11)}${"insert ms".padStart(11)}`);
let owner = 0;
for (const n of [140, 400, 1250, 2000]) {
  for (const changed of [1, Math.floor(n / 2)]) {
    const ownerId = `bench-${owner++}`;
    raw
      .prepare("INSERT INTO owners (owner_id, kind, name, reported_by, updated_at) VALUES (?, 'retainer', 'r', ?, ?)")
      .run(ownerId, holder, now);
    raw
      .prepare(
        "INSERT INTO owner_sections (owner_id, section, captured_at, observed_at, reported_by, item_count) VALUES (?, 's', ?, NULL, ?, ?)",
      )
      .run(ownerId, now, holder, n);
    const before = pack(n, 0);
    const after = pack(n, changed);
    del.run(ownerId, "s", before, now, holder);
    ins.run(ownerId, "s", before, now, holder);
    let tDelete = 0;
    let tInsert = 0;
    const runs = 6;
    for (let r = 0; r < runs; r++) {
      const packed = r % 2 ? before : after;
      let start = performance.now();
      del.run(ownerId, "s", packed, now, holder);
      tDelete += performance.now() - start;
      start = performance.now();
      ins.run(ownerId, "s", packed, now, holder);
      tInsert += performance.now() - start;
    }
    console.log(
      `${String(n).padEnd(24)}${String(changed).padStart(9)}${(tDelete / runs).toFixed(1).padStart(11)}${(tInsert / runs).toFixed(1).padStart(11)}`,
    );
  }
}
