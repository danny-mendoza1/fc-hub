import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTable } from "../src/app.ts";
import { ADMIN_TOKEN, ALICE, addMember, BOB, call, createEnv, FC, fakeIconFetch, item, send, upload } from "./helpers.ts";

const BOB_RETAINER = "33777097200000009";

describe("revoked members", () => {
  it("disappear from every read route at once", async () => {
    const env = createEnv();
    env.FETCH = fakeIconFetch;
    const alice = await addMember(env, "Alice");
    const bob = await addMember(env, "Bobmember");
    const ore = (qty: number) => [item(5111, "Iron Ore", qty, "slot 1")];
    await call(env, "POST", "/api/v1/snapshots", {
      token: alice,
      body: upload(ALICE, "Alice Example", [{ ownerId: ALICE, kind: "character", name: null, sections: [{ section: "CharacterBags", items: ore(1) }] }]),
    });
    await call(env, "POST", "/api/v1/snapshots", {
      token: bob,
      body: upload(BOB, "Bobcharacter Example", [
        { ownerId: BOB, kind: "character", name: null, sections: [{ section: "CharacterBags", items: ore(2) }] },
        { ownerId: BOB_RETAINER, kind: "retainer", name: "Bobretainer", sections: [{ section: "RetainerBags", items: ore(3) }] },
        { ownerId: FC, kind: "freeCompany", name: "Bobfc", sections: [{ section: "FreeCompanyBags", items: ore(4) }] },
      ]),
    });
    assert.equal((await call(env, "POST", "/api/v1/admin/members/2/revoke", { token: ADMIN_TOKEN })).status, 200);

    // Every member-facing GET route, with Bob's ids wherever a route takes one.
    const samples: Record<string, string> = { ownerId: BOB_RETAINER, iconId: "1000" };
    const queries: Record<string, string> = { "/api/v1/search": "?q=ore" };
    for (const r of routeTable().filter((r) => r.method === "GET" && r.policy.access === "memberOrCookie")) {
      for (const ownerId of r.path.includes(":ownerId") ? [BOB, BOB_RETAINER, FC] : [""]) {
        const path =
          r.path.replace(/:(\w+)/g, (_m, key: string) => {
            assert.ok(key in samples, `add a sample for :${key}`);
            return key === "ownerId" ? ownerId : samples[key]!;
          }) + (queries[r.path] ?? "");
        const res = await send(env, "GET", path, { token: alice });
        const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
        assert.doesNotMatch(text, /Bob/, `${path} leaks the revoked member's data: ${text.slice(0, 200)}`);
      }
    }
  });
});
