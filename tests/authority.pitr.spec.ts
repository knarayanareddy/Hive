import "./_setup";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { IncarnationMismatchError } from "../src/kernel/types";

test("authority.pitr.spec — PITR restore rotates DB incarnation and rejects pre-restore capability tokens", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  const incBefore = kernel.getIncarnation();

  // Take a clean PITR backup snapshot at T0
  const backupPath = kernel.store.exportBackupTempFile();

  try {
    // Advance state after T0: claim #801 and mint a capability token
    const claimAfterBackup = kernel.claimTask(DEFAULT_TENANT, {
      taskId: "801",
      actor: "fixer",
    });

    // Simulate disaster recovery: restore DB to T0 backup (which rotates DB incarnation)
    const incAfterRestore = kernel.store.restoreFromBackupTempFile(backupPath, true);
    assert.notEqual(incAfterRestore, incBefore);

    // Task #801 is back in 'ready' state as of T0
    assert.equal(kernel.getTask(DEFAULT_TENANT, "801").state, "ready");

    // Stale capability token from post-T0 timeline MUST be rejected with IncarnationMismatchError!
    assert.throws(
      () =>
        kernel.submitTask(DEFAULT_TENANT, {
          taskId: "801",
          token: claimAfterBackup.token,
          evidenceRefs: ["pr:ghost"],
        }),
      (err: unknown) => err instanceof IncarnationMismatchError && err.status === 409,
    );

    // Stale wake tickets/outbox rows from the post-T0 timeline must not fire either.
    assert.throws(
      () => kernel.verifyCap(DEFAULT_TENANT, claimAfterBackup.token, "task.submit"),
      (err: unknown) => err instanceof IncarnationMismatchError && err.status === 409,
    );
  } finally {
    fs.rmSync(backupPath, { force: true });
    fs.rmSync(backupPath + ".restored.db", { force: true });
  }
});
