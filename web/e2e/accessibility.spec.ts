import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";
import type axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

async function checkView(page: Page) {
  const violations = await page.evaluate(async () => {
    const results = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    });
    return results.violations.map(({ id, nodes }) => ({
      id,
      elements: nodes.map((n) => ({ target: n.target, reason: n.failureSummary })),
    }));
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [320, 1280]) {
  test(`WCAG A/AA checks and keyboard navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript({ path: axePath });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await page.keyboard.press("Tab");
    const key = page.getByLabel("API key");
    await expect(key).toBeFocused();
    await checkView(page);
    await key.fill("invalid");
    await key.press("Enter");
    await expect(key).toHaveAttribute("aria-invalid", "true");
    await expect(key).toHaveAccessibleDescription(/isn't valid/);
    await key.fill(process.env.E2E_ALICE_KEY!);
    await key.press("Enter");
    await expect(page).toHaveTitle("Search · FC Hub");
    const search = page.getByRole("searchbox");
    await search.fill("no such item");
    await expect(page.getByRole("status")).toContainText("No items found");
    await checkView(page);
    await search.fill("iron ore");
    const table = page.getByRole("table", { name: "Iron Ore holdings" });
    await expect(table.getByRole("columnheader", { name: "Held by" })).toHaveCount(1);
    await expect(table.getByRole("columnheader")).toHaveCount(5);
    await checkView(page);
    const inventory = page.getByRole("button", { name: "Inventories", exact: true });
    await inventory.focus();
    await inventory.press("Enter");
    await expect(page.getByRole("main", { name: "Inventories" })).toBeFocused();
    const comparison = page.locator("article").filter({ has: page.getByRole("heading", { name: "Items in common" }) });
    const ore = comparison.locator("summary").filter({ hasText: "Iron Ore" });
    await ore.focus();
    await ore.press("Space");
    await expect(comparison.getByText(/Sir-noodle \(retainer\)/)).toBeVisible();
    await checkView(page);
    const journals = page.getByRole("button", { name: "Wondrous Tails", exact: true });
    await journals.focus();
    await journals.press("Enter");
    await expect(page.getByRole("heading", { name: "Journals" })).toBeVisible();
    await expect(page.getByText("Shared", { exact: true }).first()).toBeVisible();
    await checkView(page);
  });
}
