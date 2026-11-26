import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";

test("outbox worker: retries a crash-staged effect to confirmed with the SAME idempotency key (no duplicate PR)", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);
  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
  const key = "task:801/attempt:1/open-pr";
  kernel.connectors.armDropAckOnce(key);
  assert.throws(
    () =>
      kernel.runEffect(DEFAULT_TENANT, {
        key,
        effect: "open-pr",
        taskId: "801",
        token: claim.token,
        args: { taskId: "801", repo: "acme/www", branch: "fix/safari-pay", headSha: "3fa9c1", title: "t" },
      }),
    /network drop after external open-pr completed/,
  );
  assert.equal(kernel.listOutbox(DEFAULT_TENANT)[0].status, "failed");

  // Worker (not a human re-running the command) picks the retryable failure up —
  // after the retry backoff window (2^attempts seconds) has elapsed.
  kernel.store.advanceClock(60_000);
  const r = kernel.processOutboxPending(DEFAULT_TENANT);
  assert.deepEqual(r, { claimed: 1, confirmed: 1, failed: 0 });
  const row = kernel.listOutbox(DEFAULT_TENANT)[0];
  assert.equal(row.status, "confirmed");
  assert.equal(kernel.connectors.inspectTenantEffects(DEFAULT_TENANT).prs.length, 1, "exactly one PR — fence holds");
});

test("outbox worker: DLP-blocked rows are terminal (never re-claimed, never reach provider)", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);
  assert.throws(
    () =>
      kernel.runEffect(DEFAULT_TENANT, {
        key: "task:801/attempt:1/post-slack-dlp",
        effect: "post-slack",
        actor: "ana",
        args: { channel: "dev", text: "leak sk_live_99887766 now" },
      }),
    /DLP blocked/,
  );
  const r = kernel.processOutboxPending(DEFAULT_TENANT);
  assert.equal(r.claimed, 0, "DLP-blocked rows must not be claimable");
  assert.equal(kernel.listOutbox(DEFAULT_TENANT)[0].status, "failed");
});

test("outbox worker: attempts-exhausted rows are failed terminally without calling the provider", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);
  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
  kernel.connectors.armDropAckOnce("poison-key");
  assert.throws(() =>
    kernel.runEffect(DEFAULT_TENANT, {
      key: "poison-key",
      effect: "open-pr",
      taskId: "801",
      token: claim.token,
      args: { taskId: "801", repo: "acme/www", branch: "b", headSha: "3fa9c1", title: "t" },
    }),
  );
  // Force the row to the attempt ceiling.
  kernel.store.db.prepare("UPDATE outbox SET attempts = 8 WHERE idempotency_key = ?").run("poison-key");
  const before = kernel.connectors.inspectTenantEffects(DEFAULT_TENANT).prs.length;
  const r = kernel.processOutboxPending(DEFAULT_TENANT);
  assert.equal(r.claimed, 0, "exhausted rows are not claimable");
  assert.equal(kernel.listOutbox(DEFAULT_TENANT)[0].status, "failed");
  assert.equal(kernel.listOutbox(DEFAULT_TENANT)[0].lastError, "max attempts exceeded");
  assert.equal(kernel.connectors.inspectTenantEffects(DEFAULT_TENANT).prs.length, before, "provider untouched");
});

test("outbox worker: locked rows are left alone; expired locks are claimable", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);
  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
  kernel.connectors.armDropAckOnce("lock-key");
  assert.throws(() =>
    kernel.runEffect(DEFAULT_TENANT, {
      key: "lock-key",
      effect: "open-pr",
      taskId: "801",
      token: claim.token,
      args: { taskId: "801", repo: "acme/www", branch: "b", headSha: "3fa9c1", title: "t" },
    }),
  );
  // Simulate another worker holding the fence far into the future.
  kernel.store.db.prepare("UPDATE outbox SET locked_by = 'other-worker', locked_until = 9999999999999 WHERE idempotency_key = ?").run("lock-key");
  assert.equal(kernel.processOutboxPending(DEFAULT_TENANT).claimed, 0, "locked rows are not claimable");
  // Lock expires → claimable again (network crash recovery), respecting retry backoff.
  kernel.store.db.prepare("UPDATE outbox SET locked_by = NULL, locked_until = NULL WHERE idempotency_key = ?").run("lock-key");
  kernel.store.advanceClock(60_000);
  assert.equal(kernel.processOutboxPending(DEFAULT_TENANT).claimed, 1, "expired lock is claimable");
  assert.equal(kernel.listOutbox(DEFAULT_TENANT)[0].status, "confirmed");
});
