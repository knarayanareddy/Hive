import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { ForbiddenError, HaltedError } from "../src/kernel/types";

test("budget.breaker.spec — 6x repeated failing signature trips circuit breaker; human /resume restores execution", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });

  // 5 calls with identical failing signature succeed under budget ($5.00 = 500c)
  for (let i = 0; i < 5; i++) {
    kernel.meterCall(DEFAULT_TENANT, {
      token: claim.token,
      costCents: 25,
      callSignature: "vitest:checkout.spec:clock_timeout",
    });
  }
  assert.equal(kernel.getTask(DEFAULT_TENANT, "801").state, "claimed");

  // 6th identical failing call trips the loop detector circuit breaker!
  assert.throws(
    () =>
      kernel.meterCall(DEFAULT_TENANT, {
        token: claim.token,
        costCents: 25,
        callSignature: "vitest:checkout.spec:clock_timeout",
      }),
    (err: unknown) => err instanceof HaltedError && err.status === 423,
  );

  assert.equal(kernel.getTask(DEFAULT_TENANT, "801").state, "halted");

  // Further writes by the agent while halted are blocked with 423 HaltedError!
  assert.throws(
    () =>
      kernel.postChannelMessage(DEFAULT_TENANT, {
        actor: "fixer",
        channel: "dev",
        taskId: "801",
        text: "still trying...",
        token: claim.token,
      }),
    (err: unknown) => err instanceof HaltedError,
  );

  // Agent cannot /resume its own halted task!
  assert.throws(
    () => kernel.executeSlashCommand(DEFAULT_TENANT, "fixer", "/resume 801 --cap 8"),
    (err: unknown) => err instanceof ForbiddenError,
  );

  // Human lead executes deterministic `/resume 801 --cap 8 --hint "mock flaky clock"`
  const resumed = kernel.executeSlashCommand(
    DEFAULT_TENANT,
    "ben",
    '/resume 801 --cap 8 --hint "mock the flaky clock"',
  );
  assert.equal(resumed.task.state, "claimed");
  assert.equal(resumed.task.budgetCapCents, 800);

  // Agent can now proceed again
  const postAfterResume = kernel.postChannelMessage(DEFAULT_TENANT, {
    actor: "fixer",
    channel: "dev",
    taskId: "801",
    text: "Mocked clock per hint — tests green now.",
    token: claim.token,
  });
  assert.equal(postAfterResume.kind, "chat.message");
});
