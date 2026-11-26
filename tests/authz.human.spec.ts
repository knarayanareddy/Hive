import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { ForbiddenError } from "../src/kernel/types";

test("authz.human.spec — human role gates: member cannot verify/approve security/revoke others' agents; owner can", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);

  // Seed an agent with security-channel post access so the full lifecycle can run on #810.
  kernel.createGrant(DEFAULT_TENANT, "ana", {
    id: "g9",
    principal: "fixer",
    path: "security/",
    can: ["post"],
  });
  // Dana (member) is granted security-channel post — she passes channel access and
  // must still be refused by the two_of_three ROLE gate.
  kernel.createGrant(DEFAULT_TENANT, "ana", {
    id: "g10",
    principal: "dana",
    path: "security/",
    can: ["post"],
  });

  // #810 touches security/search.ts -> gatePolicy === 'two_of_three'
  const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "810", actor: "fixer" });
  kernel.pushPatch(DEFAULT_TENANT, {
    taskId: "810",
    headSha: "c0ffee1",
    diff: "+ const q = parameterized(...)",
    token: claim.token,
  });
  kernel.submitTask(DEFAULT_TENANT, {
    taskId: "810",
    token: claim.token,
    headSha: "c0ffee1",
    evidenceRefs: ["scan:338"],
  });

  // 1. Member cannot fabricate a verifier receipt, even with a well-formed call!
  assert.throws(
    () =>
      kernel.verifyTask(DEFAULT_TENANT, {
        actor: "dana",
        taskId: "810",
        headSha: "c0ffee1",
        result: "pass",
      }),
    (err: unknown) =>
      err instanceof ForbiddenError && /may not perform "task\.verify"/.test(err.message),
  );

  // Independent verifier passes -> awaiting_approval
  kernel.verifyTask(DEFAULT_TENANT, {
    actor: "verifier",
    taskId: "810",
    headSha: "c0ffee1",
    result: "pass",
  });

  // 2. Member with channel access still cannot satisfy a security/ two_of_three gate!
  assert.throws(
    () =>
      kernel.decideGate(DEFAULT_TENANT, {
        actor: "dana",
        taskId: "810",
        headSha: "c0ffee1",
        decision: "approve",
      }),
    (err: unknown) =>
      err instanceof ForbiddenError && /requires role owner\|lead\|security/.test(err.message),
  );

  // 3. Member cannot revoke another human's agent!
  assert.throws(
    () => kernel.setAgentAttestationStatus(DEFAULT_TENANT, "dana", "fixer", "revoke"),
    (err: unknown) =>
      err instanceof ForbiddenError && /only the owning human "ben" or an "owner"/.test(err.message),
  );

  // 4. Owning lead CAN revoke + restore their own agent!
  kernel.setAgentAttestationStatus(DEFAULT_TENANT, "ben", "fixer", "revoke");
  kernel.setAgentAttestationStatus(DEFAULT_TENANT, "ben", "fixer", "restore");

  // 5. Lead + owner approvals (2-of-3) close the security gate — dana's denial stands.
  const benApp = kernel.decideGate(DEFAULT_TENANT, {
    actor: "ben",
    taskId: "810",
    headSha: "c0ffee1",
    decision: "approve",
    autoShip: false,
  });
  assert.equal(benApp.gateSatisfied, false);
  const anaApp = kernel.decideGate(DEFAULT_TENANT, {
    actor: "ana",
    taskId: "810",
    headSha: "c0ffee1",
    decision: "approve",
    autoShip: false,
  });
  assert.equal(anaApp.gateSatisfied, true);

  // 6. Owner can revoke an agent they do not own (root of authority).
  kernel.setAgentAttestationStatus(DEFAULT_TENANT, "ana", "fixer", "revoke");
  kernel.setAgentAttestationStatus(DEFAULT_TENANT, "ana", "fixer", "restore");
});
