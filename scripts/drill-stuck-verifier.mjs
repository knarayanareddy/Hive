#!/usr/bin/env node
/**
 * Stuck-verifier drill against a real SQLite kernel workspace.
 *
 *   seed → claim #801 (@fixer) → submit → task enters `verifying`,
 *   wake enqueued for a NON-AUTHOR verifier (author may never verify own work)
 *   → simulate verifier crash (never acks; clock advances)
 *   → schedulerTick re-delivers the wake (delivery_attempts grows)
 *   → assert: task NEVER auto-closes; verifiedClose stays unset; no evidence row
 *   → assert: the AUTHOR cannot self-verify (ForbiddenError)
 *   → recovery: the assigned non-author verifier passes verification
 *   → assert: evidence written, task leaves `verifying`
 *
 * Run: npm run drill:stuck-verifier
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-stuck-verifier-"));
const dbPath = path.join(tmp, "drill.db");
const store = new HiveStore(dbPath);
const kernel = new HiveKernel(store);
seedWorkspace(kernel, DEFAULT_TENANT);

const claim = kernel.claimTask(DEFAULT_TENANT, {
  taskId: "801",
  actor: "fixer",
  ttlMs: 60 * 60 * 1000, // long lease: the WORKER is alive; it is the VERIFIER that is stuck
});
console.log(`· @fixer claimed #801 → epoch ${claim.epoch}`);

kernel.submitTask(DEFAULT_TENANT, {
  taskId: "801",
  token: claim.token,
  headSha: "c0ffee1234",
  evidenceRefs: ["ci:green-9981"],
  summary: "Fix form.requestSubmit; verified locally",
});
let task = kernel.getTask(DEFAULT_TENANT, "801");
ok("submit moves task to verifying", task.state === "verifying", `state=${task.state}`);
ok("verifiedClose unset while unverified", !task.verifiedClose);

// Identify the wake created by THIS submission (seed pre-enqueues task.ready wakes).
const wakes = kernel.listWakes(DEFAULT_TENANT).filter(
  (w) => w.taskId === "801" && w.reason.startsWith("verify:"),
);
ok("a verifier wake was enqueued", wakes.length === 1);
const verifierWake = wakes[0];
ok(
  "wake is addressed to a NON-AUTHOR verifier",
  verifierWake.principal !== "fixer",
  `principal=${verifierWake.principal}`,
);
console.log(`· verifier wake → ${verifierWake.principal} (attempts=${verifierWake.deliveryAttempts}, acked=${verifierWake.ackAt !== null})`);

// ── Simulate a stuck/crashed verifier: clock advances, nobody acks ──────────
kernel.schedulerTick(DEFAULT_TENANT, { advanceMs: 30_000 });
kernel.schedulerTick(DEFAULT_TENANT, { advanceMs: 30_000 });
kernel.schedulerTick(DEFAULT_TENANT, { advanceMs: 30_000 });
const after = kernel.listWakes(DEFAULT_TENANT).find((w) => w.id === verifierWake.id);
console.log(`· after 3 scheduler ticks: deliveryAttempts=${after.deliveryAttempts} acked=${after.ackAt !== null}`);
ok("lost wake re-delivered (attempts grew)", after.deliveryAttempts >= 3);
ok("wake remains unacked", after.ackAt === null);

task = kernel.getTask(DEFAULT_TENANT, "801");
ok("task NEVER auto-closes while verifier is stuck", task.state === "verifying", `state=${task.state}`);
ok("verifiedClose still unset", !task.verifiedClose);

// Author must not be able to self-verify, even now
let authorBlocked = false;
try {
  kernel.verifyTask(DEFAULT_TENANT, {
    actor: "fixer",
    taskId: "801",
    headSha: "c0ffee1234",
    result: "pass",
  });
} catch {
  authorBlocked = true;
}
ok("author self-verification is forbidden", authorBlocked);

// ── Recovery: the non-author verifier completes verification ────────────────
const result = kernel.verifyTask(DEFAULT_TENANT, {
  actor: verifierWake.principal,
  taskId: "801",
  headSha: "c0ffee1234",
  result: "pass",
  details: "reproduced in clean sandbox; form.requestSubmit fires submit handler",
});
task = kernel.getTask(DEFAULT_TENANT, "801");
ok("recovery: task leaves verifying", task.state !== "verifying", `state=${task.state}`);
ok("recovery: evidence written", Boolean(result.evidence?.id), `evidence=${result.evidence?.id}`);

store.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\nSTUCK-VERIFIER DRILL: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nSTUCK-VERIFIER DRILL: ALL CHECKS PASSED");
