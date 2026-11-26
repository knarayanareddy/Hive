import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { ForbiddenError } from "../src/kernel/types";

test("verify.falseclose.spec — chat prose never closes task; false fix is rejected; author cannot self-verify", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  // Claim #804 (no human gate, so verification alone governs VerifiedClose)
  const c1 = kernel.claimTask(DEFAULT_TENANT, { taskId: "804", actor: "fixer" });

  // 1. Principle 1: Posting "Fixed ✅" in chat NEVER transitions task state!
  kernel.postChannelMessage(DEFAULT_TENANT, {
    actor: "fixer",
    channel: "dev",
    taskId: "804",
    text: "Fixed ✅ all green, closing!",
    token: c1.token,
  });
  assert.equal(kernel.getTask(DEFAULT_TENANT, "804").state, "claimed");

  // 2. Push broken patch & submit
  kernel.pushPatch(DEFAULT_TENANT, {
    taskId: "804",
    headSha: "bad0001",
    diff: "+ // incomplete fix",
    token: c1.token,
  });
  const sub1 = kernel.submitTask(DEFAULT_TENANT, {
    taskId: "804",
    token: c1.token,
    headSha: "bad0001",
    evidenceRefs: ["ci:14/14"],
  });
  assert.equal(sub1.state, "verifying");

  // 3. Author tries to verify own work (even if granted scope) -> strictly forbidden!
  kernel.registerAgent(DEFAULT_TENANT, {
    id: "self-verifier-fixer",
    owner: "ana",
    harness: "Claude Code",
    scope: ["task.claim", "task.submit", "task.verify"],
  });
  assert.throws(
    () =>
      kernel.verifyTask(DEFAULT_TENANT, {
        actor: "fixer",
        taskId: "804",
        headSha: "bad0001",
        result: "pass",
      }),
    (err: unknown) => err instanceof ForbiddenError,
  );

  // 4. Independent verifier runs clean-sandbox repro -> FAILS!
  const vFail = kernel.verifyTask(DEFAULT_TENANT, {
    actor: "verifier",
    taskId: "804",
    headSha: "bad0001",
    result: "fail",
    reproName: "cart-persistence.spec",
    details: "Hydration race still reproduces on cold cache",
  });
  assert.equal(vFail.evidence.passed, false);
  assert.equal(vFail.task.attempt, 1);
  assert.equal(vFail.task.state, "ready");
  assert.equal(vFail.task.verifiedClose, null);

  // 5. Attempt 2: fixer re-claims, pushes real fix, submits, independent verifier passes -> VerifiedClose!
  const c2 = kernel.claimTask(DEFAULT_TENANT, { taskId: "804", actor: "fixer" });
  assert.equal(c2.epoch, 2);
  kernel.pushPatch(DEFAULT_TENANT, {
    taskId: "804",
    headSha: "good002",
    diff: "+ await storageHydrated()",
    token: c2.token,
  });
  kernel.submitTask(DEFAULT_TENANT, {
    taskId: "804",
    token: c2.token,
    headSha: "good002",
    evidenceRefs: ["ci:14/14"],
  });

  const vPass = kernel.verifyTask(DEFAULT_TENANT, {
    actor: "verifier",
    taskId: "804",
    headSha: "good002",
    result: "pass",
    reproName: "cart-persistence.spec",
  });
  assert.equal(vPass.task.state, "closed");
  assert.ok(vPass.task.verifiedClose?.startsWith("vc_"));
});
