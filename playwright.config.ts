import { defineConfig } from "@playwright/test";

/**
 * UI e2e — runs against a real single-origin gateway (NOT against vite preview):
 *   HIVE_ADMIN_TOKEN=… HIVE_ENABLE_DEV_DRILLS=1 node --import tsx src/server/index.ts
 * then:
 *   HIVE_E2E_ADMIN_TOKEN=… npx playwright test
 * Browser binaries are downloaded on CI runners (`npx playwright install --with-deps chromium`);
 * this sandbox's egress allowlist blocks the browser CDN, so the suite is CI-verified only.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html"]] : "list",
  use: {
    baseURL: process.env.HIVE_E2E_BASE_URL ?? "http://127.0.0.1:8787",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
