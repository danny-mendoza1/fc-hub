import { expect, type Page, test } from "@playwright/test";

/** Seeded by e2e/server.ts: Alice (character, retainer Sir-noodle, FC chest) and Bob (saddlebag). */
const ALICE_KEY = process.env.E2E_ALICE_KEY!;

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("API key").fill(ALICE_KEY);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** Fails the test on any console error (a crashed component, a failed request...). */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("sign in, search, and sign out", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByLabel("API key").fill("fch_wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("isn't valid");

  await signIn(page);
  await page.getByPlaceholder(/Search items/).fill("iron ore");
  const card = page.locator("article", { hasText: "Iron Ore" });
  await expect(card).toContainText("Total 1,120"); // 15 + 99 + 999 + 7
  await expect(card).toContainText("Sir-noodle");
  await expect(card).toContainText("Bob");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // The signed-out session check and the wrong key are expected 401s; nothing else should fail.
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("Inventories: drill-down with Also in, and items in common with a remembered party", async ({ page }) => {
  // Watch from after sign-in: the signed-out page's session check is an expected 401.
  await signIn(page);
  const errors = watchConsole(page);
  await page.getByRole("button", { name: "Inventories" }).click();

  // Retainer drill-down: its only section opens straight away; Iron Ore is also elsewhere.
  await page.locator("summary", { hasText: "Sir-noodle" }).click();
  const alsoIn = page.locator("li", { hasText: "Iron Ore" }).getByText("Also in").locator("..");
  await expect(alsoIn).toContainText("FC chest");
  await expect(alsoIn).toContainText("Bob");

  const common = page.locator("article", { has: page.getByRole("heading", { name: "Items in common" }) });
  const ore = common.locator("summary").filter({ hasText: "Iron Ore" });
  await expect(ore).toContainText("FC chest 999");
  await expect(ore).toContainText("Alice 114"); // inventory + retainer
  await expect(ore).toContainText("+1 more");

  // Recalculate the preview for the selected holders, then remember the choice across reloads.
  const chip = (name: string) => common.getByRole("button", { name, exact: true });
  await chip("Bob").click();
  await expect(ore).not.toContainText("+1 more");
  await chip("FC chest").click();
  await expect(chip("Bob")).toHaveAttribute("aria-pressed", "false");
  await expect(common).toContainText("Pick at least two to compare.");
  await page.reload();
  await expect(page.locator("article", { has: page.getByRole("heading", { name: "Items in common" }) })).toContainText(
    "Pick at least two to compare.",
  );
  expect(errors).toEqual([]);
});

test("wondrous tails: duties in common for the chosen party", async ({ page }) => {
  await signIn(page);
  const errors = watchConsole(page);
  await page.getByRole("button", { name: "Wondrous Tails" }).click();

  const common = page.locator("article", { has: page.getByRole("heading", { name: "Duties in common" }) });
  await expect(common.locator("li", { hasText: "Objective 1" })).toContainText("Needs: Alice, Bob");

  await page.getByRole("group", { name: "Party members" }).getByRole("button", { name: "Bob" }).click();
  await expect(common).toContainText("Pick at least two party members");
  await page.reload();
  await expect(page.locator("article", { has: page.getByRole("heading", { name: "Duties in common" }) })).toContainText(
    "Pick at least two party members",
  );
  expect(errors).toEqual([]);
});
