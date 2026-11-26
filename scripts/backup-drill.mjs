#!/usr/bin/env node
/**
 * Live PITR (point-in-time recovery) drill against a throwaway SQLite workspace.
 *
 *   seed → claim #801 (epoch 1, token bound to incarnation I0)
 *   → exportBackupTempFile() snapshot
 *   → perform post-snapshot mutation (patch push)
 *   → restoreFromBackupTempFile() → incarnation rotates I0 → I1
 *   → assert: pre-restore capability token is REJECTED (incarnation claim mismatch)
 *   → assert: restored state equals the snapshot (pre-mutation)
 *   → assert: FTS5 search index survived the restore
 *
 * Mirrors tests/authority.pitr.spec.ts but against real DB files + backup/restore
 * I/O rather than an in-memory kernel.
 *
 * Run: npm run drill:backup
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveStore } from "../src/kernel/db";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-backup-drill-"));
const dbPath = path.join(tmp, "drill.db");
const store = new HiveStore(dbPath);
const kernel = new HiveKernel(store);
seedWorkspace(kernel, DEFAULT_TENANT);

const inc0 = kernel.getIncarnation();
console.log(`· incarnation before backup: ${inc0}`);

// 1. Claim task #801 as @fixer → token is bound to incarnation I0
const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer", ttlMs: 10 * 60 * 1000 });
console.log(`· @fixer claimed #801 → epoch ${claim.epoch}`);

// 2. Snapshot (PITR restore point = claim committed, no patch yet)
const backup = store.exportBackupTempFile();
console.log(`· exported PITR snapshot: ${backup}`);

// 3. Post-snapshot mutation that we will "roll back"
const patch = kernel.pushPatch(DEFAULT_TENANT, {
  taskId: "801",
  headSha: "3fa9c1",
  diff: "diff --git a/payments/checkout.ts\n- form.submit()\n+ form.requestSubmit()",
  branch: "fix/task-801",
  token: claim.token,
});
console.log(`· post-snapshot mutation committed: patch @ ${patch.headSha ?? "3fa9c1"}`);

// 3b. Plant stale WAL/SHM garbage next to the live DB — restore must discard them (H9)
fs.writeFileSync(dbPath + "-wal", Buffer.from("stale-wal-garbage-from-a-crashed-writer", "utf8"));
fs.writeFileSync(dbPath + "-shm", Buffer.from("stale-shm-garbage", "utf8"));

// 4. Restore → incarnation must rotate
const inc1 = store.restoreFromBackupTempFile(backup);
console.log(`· restored from snapshot; incarnation rotated: ${inc0} → ${inc1}`);
ok("incarnation rotates on PITR restore", inc1 !== inc0);

// 5. Pre-restore token is now rejected (stale incarnation claim)
let tokenRejected = false;
try {
  kernel.verifyCap(DEFAULT_TENANT, claim.token, "task.submit");
} catch (e) {
  tokenRejected = true;
  console.log(`· pre-restore token rejected: ${e instanceof Error ? e.message : String(e)}`);
}
ok("pre-restore capability token is rejected after PITR restore", tokenRejected);

// 6. Restored state = snapshot state (claim present, patch absent)
const task = kernel.getTask(DEFAULT_TENANT, "801");
ok("restore rolls back post-snapshot mutation (state = claimed)", task.state === "claimed", `state=${task.state}`);
ok("restore rolls back post-snapshot head_sha", !task.headSha, `headSha=${task.headSha ?? "null"}`);

// 7. FTS5 index survived restore
const hits = kernel.searchEvents(DEFAULT_TENANT, "checkout");
ok("FTS5 search works after restore", hits.length > 0, `${hits.length} hit(s)`);

// 8. Hash chain still verifies (checkpoint survived the restore)
const verification = kernel.verifyLog(DEFAULT_TENANT, "latest");
ok("hash-chain verification passes on restored log", verification.ok, `checked=${verification.checkedEvents}`);

// cleanup
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(backup, { force: true }); } catch { /* best effort */ }

if (failures > 0) {
  console.error(`\n${failures} backup-drill check(s) FAILED`);
  process.exit(1);
}
console.log("\nBACKUP/PITR DRILL: ALL CHECKS PASSED");
