import { test, expect } from "@playwright/test";

/**
 * Live Hive — single-origin proof: the UI is served by the Node gateway, signs in
 * with an admin-minted hst_ session, and renders REAL kernel state.
 */
const ADMIN_TOKEN = process.env.HIVE_E2E_ADMIN_TOKEN ?? "";

test("gateway serves the SPA with single-origin security headers", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/html");
  expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await res.text();
  expect(body).toMatch(/assets\/index-[^"]+\.js/);
});

test("API is not anonymous: /api/state → 401 without a session", async ({ request }) => {
  const res = await request.get("/api/state?tenant=acme");
  expect(res.status()).toBe(401);
});

test("sign-in with admin-minted session renders live kernel state (task 801)", async ({ page }) => {
  test.skip(!ADMIN_TOKEN, "HIVE_E2E_ADMIN_TOKEN not set");
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  await page.goto("/");
  // Sign-in panel (rendered when there is no hst_ session).
  const tokenInput = page.getByPlaceholder("HIVE_ADMIN_TOKEN");
  await expect(tokenInput).toBeVisible();
  await tokenInput.fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The kernel board renders from the live gateway.
  await expect(page.getByText("Authority Kernel")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Checkout 'Pay now'")).toBeVisible({ timeout: 10_000 });
  // SSE live badge appears (fetch-stream to /api/events on the same origin).
  await expect(page.getByText(/live/i).first()).toBeVisible({ timeout: 10_000 });
  expect(consoleErrors, "no uncaught page errors on the boot path").toEqual([]);
});
