#!/usr/bin/env node
/**
 * scripts/smoke-load.mjs — minimal load smoke for the running gateway.
 *
 *   node scripts/smoke-load.mjs [baseUrl] [connections] [rounds]
 *   node scripts/smoke-load.mjs http://127.0.0.1:8787 32 10
 *
 * Hits GET /api/health (always open) and GET /api/state (largest read).
 * Not a benchmark — a canary that the gateway degrades gracefully under
 * concurrency. For real capacity work, point k6/vegeta at it instead.
 */
const base = process.argv[2] ?? "http://127.0.0.1:8787";
const concurrency = Number(process.argv[3] ?? 32);
const rounds = Number(process.argv[4] ?? 10);

const token = process.env.HIVE_GATEWAY_TOKEN;
const headers = token ? { Authorization: `Bearer ${token}` } : {};

async function hit(pathname) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}${pathname}`, { headers });
    await res.arrayBuffer(); // drain
    return { ok: res.status === 200, status: res.status, ms: performance.now() - t0 };
  } catch {
    return { ok: false, status: 0, ms: performance.now() - t0 };
  }
}

async function run(pathname, label) {
  const lat = [];
  let errors = 0;
  for (let round = 0; round < rounds; round += 1) {
    const batch = await Promise.all(Array.from({ length: concurrency }, () => hit(pathname)));
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

console.log(`smoke-load → ${base}  concurrency=${concurrency} rounds=${rounds}${token ? " (bearer)" : " (no auth)"}`);
let errors = 0;
errors += await run("/api/health", "/api/health ");
errors += await run("/api/state?tenant=acme", "/api/state  ");
if (errors > 0) {
  console.error(`\n${errors} failed request(s)`);
  process.exit(1);
}
console.log("\nSMOKE LOAD: OK");
