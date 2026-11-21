import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke tests (e2e/): sign in and click through every tab against the built UI and a
 * seeded in-memory database. Run `npm run test:e2e` (builds first); CI runs them on every PR.
 */
const port = 4173;

// Known keys for the seeded members; the tests sign in with them.
process.env.E2E_ALICE_KEY ??= "fch_e2e-alice-key-0000000000000000000000000000";
process.env.E2E_BOB_KEY ??= "fch_e2e-bob-key-00000000000000000000000000000000";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.ts",
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(port), E2E_ALICE_KEY: process.env.E2E_ALICE_KEY, E2E_BOB_KEY: process.env.E2E_BOB_KEY },
  },
});
