import { test, expect, type Page } from "@playwright/test";

/**
 * Live Hive — single-origin proof: the UI is served by the Node gateway, signs in
 * with an admin-minted hst_ session, and renders REAL kernel state.
 *
 * UI-level tenant isolation is asserted as *session pinning* (hst_ pins tenant;
 * select disabled). Row-level isolation itself is proven by the PG RLS gate
 * (scripts/verify-postgres-rls.mjs) and the kernel tenant-scoped specs.
 */
const ADMIN_TOKEN = process.env.HIVE_E2E_ADMIN_TOKEN ?? "";

/** Mint an hst_ session via the full-page sign-in card and wait for the board. */
async function signInViaCard(page: Page, adminToken: string, principal = "ana"): Promise<void> {
  const tokenInput = page.getByPlaceholder("HIVE_ADMIN_TOKEN");
  await expect(tokenInput).toBeVisible();
  await tokenInput.fill(adminToken);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The board renders from the live gateway (exact span; several panels contain
  // the substring otherwise and strict mode rejects multi-match locators).
  await expect(page.getByText("Authority Kernel", { exact: true })).toBeVisible({ timeout: 10_000 });
}

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
  await signInViaCard(page, ADMIN_TOKEN);
  await expect(page.getByText("Checkout 'Pay now' unresponsive on Safari 17.4").first()).toBeVisible({
    timeout: 10_000,
  });
  // SSE live badge appears (fetch-stream to /api/events on the same origin).
  await expect(page.getByText(/live/i).first()).toBeVisible({ timeout: 10_000 });
  expect(consoleErrors, "no uncaught page errors on the boot path").toEqual([]);
});

test("Zombie Fence drill click-through renders kernel CAS-fencing logs", async ({ page }) => {
  test.skip(!ADMIN_TOKEN, "HIVE_E2E_ADMIN_TOKEN not set");
  await page.goto("/");
  await signInViaCard(page, ADMIN_TOKEN);
  await page.getByRole("button", { name: /Zombie Fence/ }).click();
  // The drill claims #804/lease_epoch CAS, lets it expire, re-claims, then shows the stale write rejected.
  await expect(page.getByText(/@fixer claimed #\d+ at lease_epoch=/).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/REJECTED/).first()).toBeVisible({ timeout: 10_000 });
});

test("hst_ session pins the tenant: switch, re-mint, prompt shows globex", async ({ page }) => {
  test.skip(!ADMIN_TOKEN, "HIVE_E2E_ADMIN_TOKEN not set");
  await page.goto("/");
  await signInViaCard(page, ADMIN_TOKEN);

  // While an hst_ session is active the tenant selector is pinned (RLS UX).
  const tenantSelect = page.getByLabel(/Tenant \(RLS\)/);
  await expect(tenantSelect).toBeDisabled();

  // Sign out, switch to the isolated tenant, re-mint a session for it.
  await page.getByRole("button", { name: "sign out" }).click();
  await expect(tenantSelect).toBeEnabled();
  await tenantSelect.selectOption("globex");

  await page.getByRole("button", { name: "sign in", exact: true }).click();
  const adminInput = page.getByPlaceholder("HIVE_ADMIN_TOKEN (blank if dev-open)");
  await adminInput.fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Mint session", exact: true }).click();

  // Board re-fetches for globex and the CLI prompt reflects the pinned tenant.
  await expect(page.getByText("Authority Kernel", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("ana@globex $")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel(/Tenant \(RLS\)/)).toBeDisabled();
});
