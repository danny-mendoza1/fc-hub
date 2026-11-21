/**
 * The app for the browser tests: the built UI, an in-memory database seeded with two members and
 * a little inventory and Wondrous Tails, and a fake icon source (no network). Started by
 * playwright.config.ts; keys come from its environment.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppEnv, handle } from "../src/app.ts";
import { hashKey } from "../src/auth.ts";
import { applyMigrations } from "../src/db/migrate.ts";
import { NodeSqliteDatabase } from "../src/db/sqlite.ts";
import { startServer } from "../src/node-server.ts";
import { diskAssets } from "../src/static.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.E2E_PORT ?? 4173);
const aliceKey = process.env.E2E_ALICE_KEY!;
const bobKey = process.env.E2E_BOB_KEY!;

const db = new NodeSqliteDatabase(":memory:");
applyMigrations(db, join(webRoot, "migrations"));
for (const [name, key] of [
  ["Alice", aliceKey],
  ["Bob", bobKey],
] as const) {
  db.raw.prepare("INSERT INTO members (display_name, key_hash, created_at) VALUES (?, ?, ?)").run(name, await hashKey(key), new Date().toISOString());
}

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const env: AppEnv = {
  DB: db,
  ASSETS: diskAssets(join(webRoot, "dist")),
  FETCH: async () => new Response(png, { headers: { "content-type": "image/png" } }),
};

const item = (itemId: number, name: string, quantity: number, slot: number) => ({
  itemId,
  name,
  iconId: 20000 + itemId,
  quantity,
  isHq: false,
  isCollectable: false,
  container: 0,
  sortedContainer: 0,
  sortedSlot: slot,
  location: `slot ${slot + 1}`,
});
const now = new Date().toISOString();
const character = (contentId: string, name: string) => ({ contentId, name, homeWorldId: 409, homeWorld: "Kraken" });

async function post(key: string, path: string, body: unknown): Promise<void> {
  const response = await handle(
    new Request(`http://seed.local${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  if (!response.ok) throw new Error(`Seeding ${path} failed: ${response.status} ${await response.text()}`);
}

await post(aliceKey, "/api/v1/snapshots", {
  schemaVersion: 2,
  pluginVersion: "e2e",
  capturedAt: now,
  character: character("18014498500000001", "Alice Example"),
  owners: [
    { ownerId: "18014498500000001", kind: "character", name: "Alice Example", sections: [{ section: "CharacterBags", items: [item(5111, "Iron Ore", 15, 0)] }] },
    { ownerId: "33777097200000001", kind: "retainer", name: "Sir-noodle", sections: [{ section: "RetainerBags", items: [item(5111, "Iron Ore", 99, 0), item(4551, "Potion", 3, 1)] }] },
    { ownerId: "9280933600000000001", kind: "freeCompany", name: "Example FC", sections: [{ section: "FreeCompanyBags", items: [item(5111, "Iron Ore", 999, 0)] }] },
  ],
});
await post(bobKey, "/api/v1/snapshots", {
  schemaVersion: 2,
  pluginVersion: "e2e",
  capturedAt: now,
  character: character("18014498500000002", "Bob Example"),
  owners: [{ ownerId: "18014498500000002", kind: "character", name: "Bob Example", sections: [{ section: "CharacterSaddleBags", items: [item(5111, "Iron Ore", 7, 0)] }] }],
});

// Both journals share "Objective 1" (open for both): a duty in common.
const nextWeek = new Date(Date.now() + 9 * 86_400_000).toISOString();
const journal = (contentId: string, name: string) => ({
  schemaVersion: 1,
  pluginVersion: "e2e",
  capturedAt: now,
  character: character(contentId, name),
  hasJournal: true,
  isExpired: false,
  expiresAt: nextWeek,
  secondChancePoints: 1,
  stickersPlaced: 0,
  slots: Array.from({ length: 16 }, (_, i) => ({
    index: i,
    orderId: contentId.endsWith("1") || i === 0 ? 100 + i : 300 + i,
    name: `Objective ${contentId.endsWith("1") || i === 0 ? i + 1 : `B${i + 1}`}`,
    iconId: 61800 + i,
    type: 0,
    dataId: 1000 + i,
    status: "open",
  })),
});
await post(aliceKey, "/api/v1/wondrous-tails", journal("18014498500000001", "Alice Example"));
await post(bobKey, "/api/v1/wondrous-tails", journal("18014498500000002", "Bob Example"));

startServer(env, port, "localhost", () => console.log(`e2e server on http://localhost:${port}`));
