import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against an ALREADY-RUNNING app (default http://localhost:3200), so the
 * same tests work against a dev server, a production build, or a deployed
 * environment. `scripts/smoke.sh` boots a production build and points BASE_URL
 * at it — that is the merge gate.
 */
const baseURL = process.env.BASE_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A test that only passes on a retry is a flake, and a flake that CI hides is
  // worse than a red build. Never retry locally; once in CI, and it is reported.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Keep one phone-sized viewport honest so a mobile layout regression cannot
    // ship unnoticed. Deliberately a Chromium device, not iPhone/WebKit, so
    // `npx playwright install chromium` is all a contributor needs.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
