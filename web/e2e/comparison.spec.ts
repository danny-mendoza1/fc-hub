import { expect, test } from "@playwright/test";
import type { ItemsInCommonWire } from "../src/api-types.ts";

test("comparison stays bounded when paging, searching storage, and changing quality", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/v1/items/in-common", async (route) => {
    reads++;
    const data = (await (await route.fetch()).json()) as ItemsInCommonWire;
    const ore = data.items.find((item) => item.name === "Iron Ore");
    if (!ore) throw new Error("Missing seeded Iron Ore");
    const items = Array.from({ length: 15 }, (_, i) => ({
      ...ore,
      itemId: 9000 + i,
      name: `Sample ${String(i).padStart(2, "0")}`,
      isHq: i === 14,
      places: ore.places.map(([section, , stacks]): [number, number, number] => [section, i + 1, stacks]),
    }));
    await route.fulfill({ json: { ...data, items } });
  });
  await page.goto("/");
  await page.getByLabel("API key").fill(process.env.E2E_ALICE_KEY!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Who's uploaded" }).click();

  const panel = page.locator("article").filter({ has: page.getByRole("heading", { name: "Items in common" }) });
  const cards = panel.locator("summary");
  await expect(cards).toHaveCount(6);
  await panel.getByRole("button", { name: "Next" }).click();
  await expect(panel.getByRole("status")).toHaveText("7–12 of 15 items");
  await panel.getByLabel("Filter items in common").fill("sir-noodle sample");
  await expect(panel.getByRole("status")).toHaveText("1–6 of 15 items");
  await panel.getByLabel("Quality", { exact: true }).selectOption("hq");
  await expect(cards).toHaveCount(1);
  await cards.first().click();
  await expect(panel.getByText(/Sir-noodle \(retainer\)/)).toBeVisible();
  await panel.getByLabel("Quality", { exact: true }).selectOption("all");
  await panel.getByLabel("Sort by").selectOption("quantity");
  await expect(cards.first()).toContainText("Sample 14");
  await panel.getByLabel("Filter items in common").fill("9004");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Sample 04");
  await panel.getByLabel("Filter items in common").fill("missing");
  await expect(panel.getByRole("status")).toContainText("No items");
  await panel.getByRole("link", { name: "Individual inventories" }).click();
  await expect(page.getByRole("heading", { name: "Individual inventories" })).toBeInViewport();
  expect(reads).toBe(1);
});
