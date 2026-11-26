import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { ForbiddenError } from "../src/kernel/types";

test("rls.isolation.spec — default-deny on missing tenant and provable zero-row isolation across tenants", () => {
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);
  seedWorkspace(kernel, "globex");

  // 1. Default-deny when tenant context is empty/missing
  assert.throws(
    () => kernel.listTasks(""),
    (err: unknown) => err instanceof ForbiddenError && /RLS default-deny/.test(err.message),
  );

  // 2. Mutate tenant "acme" and ensure "globex" & "initech" see strictly isolated state
  const acmeClaim = kernel.claimTask("acme", { taskId: "801", actor: "fixer" });
  assert.equal(kernel.getTask("acme", "801").state, "claimed");
  assert.equal(kernel.getTask("globex", "801").state, "ready");
  assert.equal(kernel.listTasks("initech").length, 0);
  assert.equal(kernel.listEvents("initech").length, 0);

  // 3. Cross-tenant capability token replay is rejected!
  assert.throws(
    () =>
      kernel.submitTask("globex", {
        taskId: "801",
        token: acmeClaim.token,
        evidenceRefs: ["cross-tenant"],
      }),
    (err: unknown) => err instanceof ForbiddenError && /tenant mismatch/.test(err.message),
  );
});
