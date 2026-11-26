import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HiveKernel } from "../src/kernel/authority";
import { HiveStore } from "../src/kernel/db";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-verifylog-cache-"));
  fs.chmodSync(dir, 0o700);
  return path.join(dir, "kernel.db");
}

test("verifyLog cache: out-of-process write invalidates (PRAGMA data_version) and kernel tamper invalidates (mutation epoch)", () => {
  const dbPath = tempDbPath();
  const kernel = new HiveKernel(new HiveStore(dbPath));
  seedWorkspace(kernel, DEFAULT_TENANT);

  const first = kernel.verifyLog(DEFAULT_TENANT);
  assert.equal(first.ok, true, "freshly seeded log verifies");
  assert.ok(first.checkedEvents > 0);

  // Warm-cache call must agree.
  const warm = kernel.verifyLog(DEFAULT_TENANT);
  assert.equal(warm.ok, true);
  assert.equal(warm.checkedEvents, first.checkedEvents);

  // ── Out-of-process tamper: a SECOND connection rewrites an event row. The kernel
  //    never sees the write — PRAGMA data_version is the only signal it gets.
  const outsider = new DatabaseSync(dbPath);
  const row = outsider.prepare("SELECT seq FROM event WHERE tenant_id = ? ORDER BY seq ASC LIMIT 1").get(DEFAULT_TENANT) as { seq: number };
  outsider
    .prepare("UPDATE event SET payload_json = replace(payload_json, '{', '{\"x\":1,') WHERE tenant_id = ? AND seq = ?")
    .run(DEFAULT_TENANT, row.seq);
  outsider.close();

  const afterOutside = kernel.verifyLog(DEFAULT_TENANT);
  assert.equal(afterOutside.ok, false, "out-of-band tamper must not be hidden by the verify cache");

  // ── Kernel-mediated tamper path (mutationEpoch): fresh kernel, in-kernel drill
  const dbPath2 = tempDbPath();
  const kernel2 = new HiveKernel(new HiveStore(dbPath2));
  seedWorkspace(kernel2, DEFAULT_TENANT);
  assert.equal(kernel2.verifyLog(DEFAULT_TENANT).ok, true);
  kernel2.tamperEventForDrill(DEFAULT_TENANT, 1, "out-of-band-edit");
  assert.equal(kernel2.verifyLog(DEFAULT_TENANT).ok, false, "in-kernel tamper must invalidate immediately");
});
