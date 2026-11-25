import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { FencedError } from "../src/kernel/types";

test("fence.zombie.spec — expired lease is fenced on CAS epoch across task & outbox writes", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  // 1. fixer claims #801 at epoch 1
  const claim1 = kernel.claimTask(DEFAULT_TENANT, {
    taskId: "801",
    actor: "fixer",
    ttlMs: 10 * 60 * 1000,
  });
  assert.equal(claim1.epoch, 1);
  assert.equal(claim1.task.state, "claimed");

  // 2. fixer stalls past 10m TTL -> scheduler expires lease and re-queues #801
  const tick = kernel.schedulerTick(DEFAULT_TENANT, { advanceMs: 15 * 60 * 1000 });
  assert.deepEqual(tick.expiredTasks, ["801"]);
  assert.equal(kernel.getTask(DEFAULT_TENANT, "801").state, "ready");
  // Epoch stays at 1 until next claim bumps it to 2
  assert.equal(kernel.getTask(DEFAULT_TENANT, "801").leaseEpoch, 1);

  // 3. codex claims #801 -> epoch bumps 1 -> 2
  const claim2 = kernel.claimTask(DEFAULT_TENANT, {
    taskId: "801",
    actor: "codex",
    ttlMs: 30 * 60 * 1000,
  });
  assert.equal(claim2.epoch, 2);
  assert.equal(claim2.task.owner, "codex");

  // Even if zombie fixer's token had a long TTL (mint a fresh-looking stale epoch=1 token scenario by testing before/after):
  // Let's also test an unexpired-looking token whose epoch is 1 when task is at epoch 2!
  const k2 = new HiveKernel();
  seedWorkspace(k2, DEFAULT_TENANT);
  const longClaim1 = k2.claimTask(DEFAULT_TENANT, {
    taskId: "804",
    actor: "fixer",
    ttlMs: 120 * 60 * 1000,
  });
  // Force heartbeat timeout at +121m is expired; to test pure epoch mismatch while token is still unexpired,
  // advance 121m so task expires, or test claim1 against claim2:
  assert.throws(
    () =>
      kernel.submitTask(DEFAULT_TENANT, {
        taskId: "801",
        token: claim1.token,
        evidenceRefs: ["pr:stale"],
      }),
    (err: unknown) => err instanceof FencedError && err.status === 409,
  );

  // Also test pure stale-epoch rejection when token hasn't hit wallclock expiry yet:
  // Simulate task #804 reassigned to epoch 2 while zombie holds epoch=1 token with valid wallclock
  k2.store.db
    .prepare("UPDATE task SET state = 'ready', owner = NULL WHERE tenant_id = ? AND id = '804'")
    .run(DEFAULT_TENANT);
  const c2 = k2.claimTask(DEFAULT_TENANT, { taskId: "804", actor: "codex" });
  assert.equal(c2.epoch, 2);

  // Zombie fixer wakes up with unexpired epoch=1 token and attempts patch, submit, and open-pr!
  assert.throws(
    () =>
      k2.pushPatch(DEFAULT_TENANT, {
        taskId: "804",
        headSha: "deadbeef",
        diff: "stale patch",
        token: longClaim1.token,
      }),
    (err: unknown) => err instanceof FencedError && err.status === 409,
  );

  assert.throws(
    () =>
      k2.runEffect(DEFAULT_TENANT, {
        key: "task:804/zombie/open-pr",
        effect: "open-pr",
        taskId: "804",
        token: longClaim1.token,
        args: { taskId: "804", repo: "acme/www", branch: "fix/zombie" },
      }),
    (err: unknown) => err instanceof FencedError && err.status === 409,
  );

  // Verify no state change and ZERO PRs opened by zombie!
  const t804 = k2.getTask(DEFAULT_TENANT, "804");
  assert.equal(t804.owner, "codex");
  assert.equal(t804.leaseEpoch, 2);
  assert.equal(t804.headSha, null);
  assert.equal(k2.connectors.inspectTenantEffects(DEFAULT_TENANT).prs.length, 0);
  const fenceEvents = k2
    .listEvents(DEFAULT_TENANT, { taskId: "804" })
    .filter((e) => e.kind === "fence.rejected");
  assert.equal(fenceEvents.length, 2);
});
