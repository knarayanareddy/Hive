#!/usr/bin/env node
/**
 * scripts/smoke-load.mjs — minimal load smoke + verifyLog-cache drill for the gateway.
 *
 *   node scripts/smoke-load.mjs [baseUrl] [connections] [rounds]
 *   node scripts/smoke-load.mjs http://127.0.0.1:8787 32 10
 *
 * Steps:
 *   1. GET /api/health (always open)
 *   2. GET /api/state  (largest read) — requires an hst_ session minted via the
 *      admin bootstrap: set HIVE_ADMIN_TOKEN (+ optional HIVE_SMOKE_TENANT=acme,
 *      HIVE_SMOKE_PRINCIPAL=ben). Falls back to HIVE_GATEWAY_TOKEN if the admin
 *      mint is unavailable; /api/state will then 401 by design (sessions required).
 *   3. ETag drill: conditional re-fetch of /api/state (If-None-Match) → expect 304.
 *   4. Optional VERIFYLOG CACHE DRILL (opt-in, destructive):
 *        HIVE_SMOKE_ALLOW_RESET=1 HIVE_ADMIN_TOKEN=… node scripts/smoke-load.mjs
 *      wipes and re-seeds the demo DB via POST /api/reset (server must run with
 *      HIVE_ENABLE_DEV_DRILLS=1) and asserts the post-reset snapshot verifies —
 *      i.e. the kernel's verifyLog cache did not serve a stale result across the
 *      DB-file replacement. Not a benchmark — k6/vegeta for real capacity work.
 */
const base = process.argv[2] ?? "http://127.0.0.1:8787";
const concurrency = Number(process.argv[3] ?? 32);
const rounds = Number(process.argv[4] ?? 10);

const adminToken = process.env.HIVE_ADMIN_TOKEN;
const gatewayToken = process.env.HIVE_GATEWAY_TOKEN;
const tenant = process.env.HIVE_SMOKE_TENANT ?? "acme";
const principalId = process.env.HIVE_SMOKE_PRINCIPAL ?? "ben";

async function mintSession() {
  if (!adminToken) return null;
  try {
    const res = await fetch(`${base}/api/session/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tenant, principalId, ttlSeconds: 300 }),
    });
    const body = await res.json();
    if (!res.ok || !body.token) {
      console.error(`mint session failed: ${res.status} ${JSON.stringify(body)}`);
      return null;
    }
    return body.token;
  } catch (e) {
    console.error(`mint session error: ${e?.message ?? e}`);
    return null;
  }
}

const session = await mintSession();
const stateHeaders = session
  ? { Authorization: `Bearer ${session}` }
  : gatewayToken
    ? { Authorization: `Bearer ${gatewayToken}` }
    : {};
console.log(`auth: ${session ? `hst_ session (${principalId}@${tenant})` : gatewayToken ? "gateway token only (state will 401)" : "none"}`);

async function hit(pathname, headers = stateHeaders) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}${pathname}`, { headers });
    const body = await res.arrayBuffer(); // drain
    return { ok: res.status === 200, status: res.status, ms: performance.now() - t0, bytes: body.byteLength, etag: res.headers.get("etag") };
  } catch {
    return { ok: false, status: 0, ms: performance.now() - t0, bytes: 0, etag: null };
  }
}

async function run(pathname, label, headers) {
  const lat = [];
  let errors = 0;
  for (let round = 0; round < rounds; round += 1) {
    const batch = await Promise.all(Array.from({ length: concurrency }, () => hit(pathname, headers)));
    for (const r of batch) {
      if (r.ok) lat.push(r.ms);
      else errors += 1;
    }
  }
  lat.sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0);
  const total = rounds * concurrency;
  console.log(
    `${label}  n=${total} ok=${lat.length} errors=${errors}  ` +
      `p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms max=${(lat.at(-1) ?? 0).toFixed(1)}ms`,
  );
  return errors;
}

console.log(`smoke-load → ${base}  concurrency=${concurrency} rounds=${rounds}`);
let errors = 0;
errors += await run("/api/health", "/api/health ", {});
errors += await run("/api/state", "/api/state  ", stateHeaders);

// ── single-origin static drill (${'`'}GET / must serve the Vite build${'`'}) ──
{
  const res = await fetch(`${base}/`);
  const body = await res.text();
  const csp = res.headers.get("content-security-policy");
  const nosniff = res.headers.get("x-content-type-options");
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  const hasBundle = /assets\/index-[^"]+\.js/.test(body);
  if (res.status === 200 && isHtml && hasBundle && csp && nosniff === "nosniff") {
    console.log("static drill: 200 text/html + CSP + nosniff ✓");
  } else if (res.status === 404) {
    console.log("static drill: no SPA served (dist/ missing or HIVE_STATIC_DIR=off) — skipping");
  } else {
    console.error(`static drill: FAILED status=${res.status} html=${isHtml} bundle=${hasBundle} csp=${Boolean(csp)} nosniff=${nosniff}`);
    errors += 1;
  }
}

// ── ETag / 304 drill (no mutation) ──────────────────────────────────────────
{
  const first = await hit("/api/state", stateHeaders);
  if (!first.ok) {
    console.error("etag drill: baseline /api/state failed");
    errors += 1;
  } else if (!first.etag) {
    console.log("etag drill: server sent no ETag (skipping 304 check)");
  } else {
    const res = await fetch(`${base}/api/state`, { headers: { ...stateHeaders, "If-None-Match": first.etag } });
    if (res.status === 304) {
      console.log(`etag drill: 304 Not Modified ✓ (${first.etag})`);
    } else {
      console.error(`etag drill: expected 304, got ${res.status}`);
      errors += 1;
    }
  }
}

// ── verifyLog cache invalidation drill (opt-in, destructive) ─────────────────
if (process.env.HIVE_SMOKE_ALLOW_RESET === "1") {
  if (!adminToken) {
    console.error("cache drill: HIVE_ADMIN_TOKEN required");
    process.exit(1);
  }
  const beforeRes = await fetch(`${base}/api/state`, { headers: stateHeaders });
  const before = await beforeRes.json();
  const resetRes = await fetch(`${base}/api/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: "{}",
  });
  if (!resetRes.ok) {
    console.error(`cache drill: /api/reset failed (${resetRes.status}) — is HIVE_ENABLE_DEV_DRILLS=1?`);
    process.exit(1);
  }
  const session2 = await mintSession(); // sessions die with the DB file
  const afterRes = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${session2}` } });
  const after = await afterRes.json();
  const ok = after?.logVerification?.ok === true && after?.incarnation !== before?.incarnation;
  console.log(
    `cache drill: incarnation ${String(before?.incarnation).slice(0, 8)}… → ${String(after?.incarnation).slice(0, 8)}…, ` +
      `logVerification.ok=${after?.logVerification?.ok} → ${ok ? "PASS" : "FAIL"}`,
  );
  if (!ok) errors += 1;
} else {
  console.log("cache drill: skipped (set HIVE_SMOKE_ALLOW_RESET=1 to run; it wipes and re-seeds the demo DB)");
}

if (errors > 0) {
  console.error(`\n${errors} failed request(s)`);
  process.exit(1);
}
console.log("\nSMOKE LOAD: OK");
