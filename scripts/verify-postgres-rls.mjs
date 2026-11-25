#!/usr/bin/env node
/**
 * scripts/verify-postgres-rls.mjs
 *
 * Applies db/migrations/001_postgres_rls.sql to a THROWAWAY database and proves,
 * as a NON-SUPERUSER / NON-OWNER role, that:
 *
 *   1. The migration applies cleanly on Postgres 16 (idempotent re-run included).
 *   2. Every RLS-protected table has relrowsecurity = true AND relforcerowsecurity = true.
 *   3. Default-deny: a hive_app connection WITHOUT `SET app.tenant_id = ...`
 *      reads ZERO rows from every tenant table.
 *   4. Empty tenant (`SET app.tenant_id = ''`) reads ZERO rows (default-deny).
 *   5. Tenant A cannot read, update, or delete Tenant B's rows.
 *   6. Tenant A INSERT with tenant_id = B is rejected by WITH CHECK (RLS violation).
 *   7. Tenant A UPDATE/DELETE only touches Tenant A rows.
 *   8. hive_app has SELECT on authority_meta (incarnation bootstrap) but NO
 *      INSERT/UPDATE/DELETE (governed by the gateway, not the app role).
 *   9. A full-text-search query scoped by tenant_id returns only own-tenant rows.
 *
 * Usage:
 *   HIVE_PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     node scripts/verify-postgres-rls.mjs
 *
 * For a unix-socket Postgres (e.g. user-space pgserver):
 *   HIVE_PG_ADMIN_URL='postgresql://postgres:@/postgres?host=/path/to/socketdir' \
 *     node scripts/verify-postgres-rls.mjs
 *
 * The verification database (default `hive_rls_verify`) is DROPPED and recreated
 * on every run. It never touches any other database. Set HIVE_PG_VERIFY_DB to
 * override the throwaway name. Role `hive_rls_app` is dropped/recreated too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, "../db/migrations/001_postgres_rls.sql"),
  "utf8",
);

const ADMIN_URL = process.env.HIVE_PG_ADMIN_URL;
if (!ADMIN_URL) {
  console.error("ERROR: HIVE_PG_ADMIN_URL is required (admin connection to a Postgres 16 server).");
  process.exit(1);
}
const VERIFY_DB = process.env.HIVE_PG_VERIFY_DB ?? "hive_rls_verify";
const APP_ROLE = "hive_rls_app";
const APP_PASSWORD = "hive_rls_app_pw";
const RLS_TABLES = [
  "principal",
  "grant_rule",
  "task",
  "task_dep",
  "event",
  "checkpoint",
  "evidence",
  "approval",
  "outbox",
  "wake_queue",
  "read_cursor",
  "call_telemetry",
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function appUrl() {
  const cfg = parseConnectionString(ADMIN_URL);
  return { ...cfg, user: APP_ROLE, password: APP_PASSWORD, database: VERIFY_DB };
}
function dbUrl() {
  const cfg = parseConnectionString(ADMIN_URL);
  return { ...cfg, database: VERIFY_DB };
}

async function main() {
  // ── 1. Recreate throwaway database ───────────────────────────────────────
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${VERIFY_DB} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN NOINHERIT PASSWORD '${APP_PASSWORD}'`);
  await admin.query(`CREATE DATABASE ${VERIFY_DB}`);
  await admin.end();
  console.log(`· recreated throwaway database ${VERIFY_DB} and role ${APP_ROLE}`);

  const db = new Client(dbUrl());
  await db.connect();

  // ── 2. Apply migration (twice: idempotent) ───────────────────────────────
  await db.query(MIGRATION);
  await db.query(MIGRATION);
  check("migration applies cleanly & is idempotent", true);

  // ── 3. Grants for the app role (env-specific, not in the migration) ──────
  await db.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  for (const t of RLS_TABLES) {
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLE}`);
  }
  await db.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  await db.query(`GRANT SELECT ON authority_meta TO ${APP_ROLE}`); // incarnation bootstrap only
  console.log("· granted least-privilege table privileges to app role");

  // ── 4. Seed two tenants as superuser (bypasses RLS) ──────────────────────
  await db.query(
    `INSERT INTO authority_meta (singleton, incarnation, gateway_pub) VALUES (1, gen_random_uuid(), 'verify-gateway-pub')`,
  );
  for (const tenant of ["tenant_a", "tenant_b"]) {
    await db.query(`INSERT INTO principal (id, tenant_id, kind, pubkey, role) VALUES ('ada', $1, 'human', 'pub_a', 'owner')`, [tenant]);
    await db.query(`INSERT INTO principal (id, tenant_id, kind, pubkey, owner, harness, role) VALUES ('fixer', $1, 'agent', 'pub_f', 'ada', 'claude', 'worker')`, [tenant]);
    await db.query(
      `INSERT INTO task (id, tenant_id, channel, title, state, origin_operation_id, trust, head_sha)
       VALUES ('801', $1, 'dev', 'checkout bug ' || $1, 'ready', 'op_' || $1, 'member', 'sha_' || $1)`,
      [tenant],
    );
    await db.query(
      `INSERT INTO event (tenant_id, id, prev, kind, actor, channel, task_id, payload, trust, sig)
       VALUES ($1, 'evt_' || $1, 'genesis', 'task.created', 'ada', 'dev', '801', $2, 'member', 'sig')`,
      [tenant, JSON.stringify({ title: "checkout bug", tenant })],
    );
  }
  console.log("· seeded tenant_a and tenant_b");

  // ── 5. FORCE RLS flags on every tenant table ─────────────────────────────
  const flags = await db.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)`,
    [RLS_TABLES],
  );
  const flagOk =
    flags.rows.length === RLS_TABLES.length &&
    flags.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity);
  check("ENABLE + FORCE ROW LEVEL SECURITY on all 12 tenant tables", flagOk,
    flags.rows.map((r) => `${r.relname}:rls=${r.relrowsecurity},force=${r.relforcerowsecurity}`).join(","));

  // ── 6. App-role isolation proofs (non-superuser, non-owner) ─────────────
  const app = new Client(appUrl());
  await app.connect();

  const q = async (sql, params = []) => (await app.query(sql, params)).rows;

  // default deny: unset tenant
  await app.query("RESET app.tenant_id").catch(() => app.query("SET app.tenant_id = DEFAULT"));
  for (const t of RLS_TABLES) {
    const rows = await q(`SELECT count(*)::int AS n FROM ${t}`);
    check(`default-deny (tenant unset): SELECT ${t} → 0 rows`, rows[0].n === 0);
  }

  // default deny: empty tenant
  await app.query("SET app.tenant_id = ''");
  const emptyRows = await q("SELECT count(*)::int AS n FROM task");
  check("default-deny (tenant = ''): SELECT task → 0 rows", emptyRows[0].n === 0);

  // tenant_a sees only its own rows
  await app.query("SET app.tenant_id = 'tenant_a'");
  const aTasks = await q("SELECT tenant_id, title FROM task");
  check("tenant_a sees only tenant_a tasks", aTasks.length === 1 && aTasks[0].tenant_id === "tenant_a");
  const aEvents = await q("SELECT tenant_id FROM event");
  check("tenant_a sees only tenant_a events", aEvents.length === 1 && aEvents[0].tenant_id === "tenant_a");
  const aFts = await q(
    "SELECT tenant_id FROM event WHERE fts_doc @@ to_tsquery('english', 'checkout')",
  );
  check("FTS query scoped by tenant_id returns only tenant_a rows", aFts.length === 1 && aFts[0].tenant_id === "tenant_a");

  // deny cross-tenant INSERT via WITH CHECK
  let insertDenied = false;
  try {
    await app.query(
      `INSERT INTO principal (id, tenant_id, kind, pubkey, role) VALUES ('mallory', 'tenant_b', 'human', 'pub_m', 'owner')`,
    );
  } catch (e) {
    insertDenied = /row-level security|row violates/i.test(String(e.message));
  }
  check("tenant_a cannot INSERT a tenant_b principal (WITH CHECK)", insertDenied);

  // deny cross-tenant UPDATE / DELETE
  const upd = await app.query("UPDATE task SET title = 'pwned' WHERE tenant_id = 'tenant_b'");
  check("tenant_a UPDATE tenant_b tasks affects 0 rows", upd.rowCount === 0);
  const del = await app.query("DELETE FROM task WHERE tenant_id = 'tenant_b'");
  check("tenant_a DELETE tenant_b tasks affects 0 rows", del.rowCount === 0);

  // own-tenant update works
  const ownUpd = await app.query("UPDATE task SET title = 'tenant_a updated' WHERE tenant_id = 'tenant_a'");
  check("tenant_a can UPDATE its own tasks", ownUpd.rowCount === 1);

  // authority_meta: SELECT allowed (incarnation bootstrap), writes denied
  let metaSelectOk = false;
  try {
    await q("SELECT incarnation FROM authority_meta");
    metaSelectOk = true;
  } catch { /* no */ }
  check("app role can SELECT authority_meta (incarnation bootstrap)", metaSelectOk);
  let metaWriteDenied = false;
  try {
    await app.query(`DELETE FROM authority_meta`);
  } catch (e) {
    metaWriteDenied = /permission denied/i.test(String(e.message));
  }
  check("app role CANNOT write authority_meta (permission denied)", metaWriteDenied);

  // tenant_b still intact after all attempts
  await app.query("SET app.tenant_id = 'tenant_b'");
  const bAfter = await q("SELECT title FROM task");
  check("tenant_b rows survive tenant_a's attacks", bAfter.length === 1 && bAfter[0].title === "checkout bug tenant_b");

  await app.end();
  await db.end();

  // ── 7. Cleanup throwaway database ────────────────────────────────────────
  const cleaner = new Client({ connectionString: ADMIN_URL });
  await cleaner.connect();
  await cleaner.query(`DROP DATABASE IF EXISTS ${VERIFY_DB} WITH (FORCE)`);
  await cleaner.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  await cleaner.end();
  console.log(`· dropped throwaway database ${VERIFY_DB} and role ${APP_ROLE}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} RLS checks passed`);
  if (failed.length) process.exit(1);
  console.log("POSTGRES RLS: ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("verify-postgres-rls failed:", err);
  process.exit(1);
});
