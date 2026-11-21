import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Fetcher } from "../src/icons.ts";
import { xivapiIconUrl } from "../src/icons.ts";
import { ALICE, ALICE_RETAINER, addMember, call, createEnv, item, upload } from "./helpers.ts";

describe("owner items (accordion data)", () => {
  let env: ReturnType<typeof createEnv>;
  let key: string;

  beforeEach(async () => {
    env = createEnv();
    key = await addMember(env, "Alice");
    const body = upload(ALICE, "Alice Example", [
      {
        ownerId: ALICE_RETAINER,
        kind: "retainer",
        name: "Sir-noodle",
        sections: [
          {
            section: "RetainerBags",
            items: [
              item(5057, "Iron Ore", 50, "Retainer · page 2 · slot 1", { sortedContainer: 10001, sortedSlot: 0 }),
              item(4552, "Hi-Potion", 19, "Retainer · page 1 · slot 28", { sortedContainer: 10000, sortedSlot: 27 }),
              item(4551, "Potion", 3, "Retainer · page 1 · slot 2", { sortedContainer: 10000, sortedSlot: 1 }),
            ],
          },
          {
            section: "RetainerMarket",
            items: [item(36104, "Grade 5 Tincture of Strength", 5, "Retainer (market) · slot 1", { isHq: true })],
          },
        ],
      },
    ]);
    await call(env, "POST", "/api/v1/snapshots", { token: key, body });
  });

  it("returns every section in bag/slot order with who reported it", async () => {
    const res = await call(env, "GET", `/api/v1/owners/${ALICE_RETAINER}/items`, { token: key });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.owner, { ownerId: ALICE_RETAINER, kind: "retainer", name: "Sir-noodle" });
    assert.deepEqual(
      res.body.sections.map((s: any) => [s.section, s.itemCount, s.reportedBy.member]),
      [
        ["RetainerBags", 3, "Alice"],
        ["RetainerMarket", 1, "Alice"],
      ],
    );
    assert.deepEqual(
      res.body.sections[0].items.map((i: any) => i.name),
      ["Potion", "Hi-Potion", "Iron Ore"],
      "page 1 slot 2, page 1 slot 28, page 2 slot 1",
    );
    assert.equal(res.body.sections[1].items[0].isHq, true);
    assert.equal(res.body.sections[1].items[0].iconId, 1000 + 36104);
  });

  it("validates the id, requires sign-in, and 404s unknown owners", async () => {
    assert.equal((await call(env, "GET", `/api/v1/owners/${ALICE_RETAINER}/items`)).status, 401);
    assert.equal((await call(env, "GET", "/api/v1/owners/abc/items", { token: key })).status, 400);
    assert.equal((await call(env, "GET", "/api/v1/owners/123/items", { token: key })).status, 404);
  });
});

describe("icon proxy", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function fakeUpstream(response: () => Response | Promise<Response>) {
    const calls: string[] = [];
    const fetcher: Fetcher = async (input) => {
      calls.push(input);
      return response();
    };
    return { calls, fetcher };
  }

  it("builds XIVAPI's high-res icon path", () => {
    assert.equal(xivapiIconUrl(20603), "https://v2.xivapi.com/api/asset?path=ui/icon/020000/020603_hr1.tex&format=png");
    assert.equal(xivapiIconUrl(51474), "https://v2.xivapi.com/api/asset?path=ui/icon/051000/051474_hr1.tex&format=png");
    assert.equal(xivapiIconUrl(65002), "https://v2.xivapi.com/api/asset?path=ui/icon/065000/065002_hr1.tex&format=png");
  });

  it("serves the PNG with long private caching", async () => {
    const upstream = fakeUpstream(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const env = { ...createEnv(), FETCH: upstream.fetcher };
    const key = await addMember(env, "Alice");

    const { handle } = await import("../src/app.ts");
    const res = await handle(new Request("https://hub.test/api/v1/icons/20603", { headers: { authorization: `Bearer ${key}` } }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "private, max-age=2592000, immutable");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
    assert.deepEqual(upstream.calls, [xivapiIconUrl(20603)]);
  });

  it("is not an open proxy: members only, numeric ids only", async () => {
    const upstream = fakeUpstream(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const env = { ...createEnv(), FETCH: upstream.fetcher };
    const key = await addMember(env, "Alice");

    assert.equal((await call(env, "GET", "/api/v1/icons/20603")).status, 401);
    for (const bad of ["0", "abc", "1234567", "20603.png", "..%2f..%2fetc"]) {
      assert.equal((await call(env, "GET", `/api/v1/icons/${bad}`, { token: key })).status, 400, bad);
    }
    assert.equal(upstream.calls.length, 0, "upstream must not be called for rejected requests");
  });

  it("maps upstream failures without caching them", async () => {
    const cases: [string, () => Response | Promise<Response>, number][] = [
      ["404", () => new Response("missing", { status: 404 }), 404],
      ["html instead of png", () => new Response("<html>", { headers: { "content-type": "text/html" } }), 502],
      ["network error", () => Promise.reject(new Error("boom")), 502],
    ];
    for (const [label, response, expected] of cases) {
      const env = { ...createEnv(), FETCH: fakeUpstream(response).fetcher };
      const key = await addMember(env, "Alice");
      const { handle } = await import("../src/app.ts");
      const res = await handle(new Request("https://hub.test/api/v1/icons/20603", { headers: { authorization: `Bearer ${key}` } }), env);
      assert.equal(res.status, expected, label);
      assert.equal(res.headers.get("cache-control"), "no-store", label);
    }
  });
});
