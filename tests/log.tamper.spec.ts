import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";

test("log.tamper.spec — editing a historical event row breaks hash-chain verification at exact seq", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  const clean = kernel.verifyLog(DEFAULT_TENANT, "latest");
  assert.equal(clean.ok, true);
  assert.equal(clean.checkpointVerified, true);
  assert.ok(clean.checkedEvents >= 5);

  const events = kernel.listEvents(DEFAULT_TENANT);
  const targetSeq = events[2].seq;

  // Tamper with historical event payload directly in storage
  kernel.tamperEventForDrill(DEFAULT_TENANT, targetSeq, "malicious retroactive edit");

  const broken = kernel.verifyLog(DEFAULT_TENANT, "latest");
  assert.equal(broken.ok, false);
  assert.equal(broken.badSeq, targetSeq);
  assert.match(broken.reason ?? "", /content hash mismatch/);
});
