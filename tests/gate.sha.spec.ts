import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { ConflictError, ForbiddenError } from "../src/kernel/types";

test("gate.sha.spec — SHA-bound approvals enforce human sign-off, reject agent self-approval, and invalidate on new push (TOCTOU safe)", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  // #801 touches payments/checkout.ts -> gatePolicy === 'one'
  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
  kernel.pushPatch(DEFAULT_TENANT, {
    taskId: "801",
    headSha: "3fa9c1",
    diff: "+ form.requestSubmit()",
    token: claim.token,
  });
  kernel.submitTask(DEFAULT_TENANT, {
    taskId: "801",
    token: claim.token,
    headSha: "3fa9c1",
    evidenceRefs: ["pr:4412", "ci:14/14"],
  });

  // Independent verifier passes SHA 3fa9c1 -> enters 'awaiting_approval' (NOT merged!)
  const ver1 = kernel.verifyTask(DEFAULT_TENANT, {
    actor: "verifier",
    taskId: "801",
    headSha: "3fa9c1",
    result: "pass",
  });
  assert.equal(ver1.task.state, "awaiting_approval");

  // 1. Merge / ship without approval is refused!
  assert.throws(
    () => kernel.shipTask(DEFAULT_TENANT, "ben", "801"),
    (err: unknown) => err instanceof ForbiddenError && /requires 1 valid human approval/.test(err.message),
  );

  // 2. Agent trying to cast approval is refused!
  assert.throws(
    () =>
      kernel.decideGate(DEFAULT_TENANT, {
        actor: "goose-triage",
        taskId: "801",
        headSha: "3fa9c1",
        decision: "approve",
      }),
    (err: unknown) => err instanceof ForbiddenError && /agents cannot approve/.test(err.message),
  );

  // 3. Approving a mismatched SHA is refused with 409 Conflict!
  assert.throws(
    () =>
      kernel.decideGate(DEFAULT_TENANT, {
        actor: "ana",
        taskId: "801",
        headSha: "wrongsha",
        decision: "approve",
      }),
    (err: unknown) => err instanceof ConflictError,
  );

  // 4. Human approves SHA 3fa9c1 with autoShip: false -> then a NEW commit 99b2e0 is pushed!
  const app1 = kernel.decideGate(DEFAULT_TENANT, {
    actor: "ana",
    taskId: "801",
    headSha: "3fa9c1",
    decision: "approve",
    autoShip: false,
  });
  assert.equal(app1.gateSatisfied, true);

  // New commit pushed after approval -> invalidates prior approval AND requires re-verification of 99b2e0!
  const afterPush = kernel.pushPatch(DEFAULT_TENANT, {
    taskId: "801",
    headSha: "99b2e0",
    diff: "+ form.requestSubmit(); // extra Safari 16 guard",
    actor: "fixer",
  });
  assert.equal(afterPush.state, "verifying");
  assert.notEqual(kernel.listApprovals(DEFAULT_TENANT, "801")[0].invalidatedAt, null);
  assert.equal(kernel.isMergeAllowed(DEFAULT_TENANT, "801").allowed, false);

  // Re-verify 99b2e0 -> still blocked until fresh human approval on 99b2e0!
  kernel.verifyTask(DEFAULT_TENANT, {
    actor: "verifier",
    taskId: "801",
    headSha: "99b2e0",
    result: "pass",
  });
  assert.equal(kernel.isMergeAllowed(DEFAULT_TENANT, "801").allowed, false);

  // Human approves new SHA 99b2e0 -> merges via outbox & closes with VerifiedClose!
  const finalApp = kernel.executeSlashCommand(
    DEFAULT_TENANT,
    "ana",
    "/approve 801 --sha 99b2e0",
  );
  assert.equal(finalApp.task.state, "closed");
  assert.ok(finalApp.task.verifiedClose?.startsWith("vc_"));
});
