import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";

test("outbox.replay.spec — crash between external PR creation and ack replays identical receipt without duplicate PR", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
  const key = "task:801/attempt:1/open-pr";

  // Arm simulated network crash right AFTER GitHub creates PR #4412, BEFORE outbox receives ack
  kernel.connectors.armDropAckOnce(key);

  assert.throws(
    () =>
      kernel.runEffect(DEFAULT_TENANT, {
        key,
        effect: "open-pr",
        taskId: "801",
        token: claim.token,
        args: {
          taskId: "801",
          repo: "acme/www",
          branch: "fix/safari-pay",
          headSha: "3fa9c1",
          title: "Fix Safari 17.4 Pay now button",
        },
      }),
    /network drop after external open-pr completed/,
  );

  // External connector has 1 PR (#4412), while outbox row is currently 'failed'
  assert.equal(kernel.connectors.inspectTenantEffects(DEFAULT_TENANT).prs.length, 1);
  assert.equal(kernel.listOutbox(DEFAULT_TENANT)[0].status, "failed");

  // Worker retries with the SAME idempotency key -> read-after-write reconciles PR #4412!
  const retryReceipt = kernel.runEffect(DEFAULT_TENANT, {
    key,
    effect: "open-pr",
    taskId: "801",
    token: claim.token,
    args: {
      taskId: "801",
      repo: "acme/www",
      branch: "fix/safari-pay",
      headSha: "3fa9c1",
      title: "Fix Safari 17.4 Pay now button",
    },
  });

  assert.equal(retryReceipt.prNumber, 4412);
  assert.equal(retryReceipt.reconciledViaReadBack, true);

  // Third replay hits confirmed outbox cache directly
  const cachedReceipt = kernel.runEffect(DEFAULT_TENANT, {
    key,
    effect: "open-pr",
    taskId: "801",
    token: claim.token,
    args: { taskId: "801", repo: "acme/www", branch: "fix/safari-pay" },
  });
  assert.equal(cachedReceipt.prNumber, 4412);
  assert.equal(kernel.connectors.inspectTenantEffects(DEFAULT_TENANT).prs.length, 1);
});
