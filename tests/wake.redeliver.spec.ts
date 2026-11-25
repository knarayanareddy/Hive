import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";

test("wake.redeliver.spec — lost wake is redelivered, cursor makes processing idempotent, and deps unblock ONLY on VerifiedClose", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  // #803 depends on #801 -> starts 'blocked'
  assert.equal(kernel.getTask(DEFAULT_TENANT, "803").state, "blocked");

  // Enqueue scheduled wake in 5m
  const wake = kernel.enqueueWake(DEFAULT_TENANT, {
    principal: "fixer",
    taskId: "801",
    channel: "dev",
    reason: "check CI",
    inMs: 5 * 60 * 1000,
  });

  // 1. Simulate lost delivery packet on first scheduler tick at +5m
  const droppedTick = kernel.schedulerTick(DEFAULT_TENANT, {
    advanceMs: 5 * 60 * 1000,
    dropDeliveryOnce: true,
  });
  assert.equal(droppedTick.deliveries.length, 0);

  // 2. Next tick redelivers the unacknowledged wake!
  const redelivered = kernel.schedulerTick(DEFAULT_TENANT);
  assert.ok(redelivered.deliveries.some((d) => d.wakeId === wake.id));

  // 3. Acknowledge wake -> advances read_cursor; re-acking returns 0 duplicate diff events!
  const firstAck = kernel.ackWake(DEFAULT_TENANT, wake.id);
  assert.ok(firstAck.diffEvents.length >= 1);
  const secondAck = kernel.ackWake(DEFAULT_TENANT, wake.id);
  assert.equal(secondAck.diffEvents.length, 0);

  // 4. Verify #803 stays 'blocked' through claim -> submit -> verifying -> awaiting_approval of #801,
  // and ONLY transitions to 'ready' once #801 achieves VerifiedClose!
  const c = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
  kernel.pushPatch(DEFAULT_TENANT, {
    taskId: "801",
    headSha: "3fa9c1",
    diff: "+ form.requestSubmit()",
    token: c.token,
  });
  kernel.submitTask(DEFAULT_TENANT, {
    taskId: "801",
    token: c.token,
    headSha: "3fa9c1",
    evidenceRefs: ["ci:14/14"],
  });
  assert.equal(kernel.getTask(DEFAULT_TENANT, "803").state, "blocked");

  kernel.verifyTask(DEFAULT_TENANT, {
    actor: "verifier",
    taskId: "801",
    headSha: "3fa9c1",
    result: "pass",
  });
  // Still awaiting human gate on #801 -> #803 MUST still be blocked!
  assert.equal(kernel.getTask(DEFAULT_TENANT, "801").state, "awaiting_approval");
  assert.equal(kernel.getTask(DEFAULT_TENANT, "803").state, "blocked");

  // Human approves #801 -> #801 reaches VerifiedClose -> #803 automatically unblocks to 'ready'!
  kernel.decideGate(DEFAULT_TENANT, {
    actor: "ana",
    taskId: "801",
    headSha: "3fa9c1",
    decision: "approve",
  });
  assert.equal(kernel.getTask(DEFAULT_TENANT, "801").state, "closed");
  assert.equal(kernel.getTask(DEFAULT_TENANT, "803").state, "ready");
});
