import { HiveKernel } from "./authority";

export const DEFAULT_TENANT = "acme";

export function seedWorkspace(kernel: HiveKernel, tenantId = DEFAULT_TENANT): void {
  if (kernel.listPrincipals(tenantId).length > 0) {
    return; // Already seeded
  }

  // 1. Human roots of authority (real Ed25519 keypairs)
  kernel.registerHuman(tenantId, { id: "ana", role: "owner" });
  kernel.registerHuman(tenantId, { id: "ben", role: "lead" });
  kernel.registerHuman(tenantId, { id: "dana", role: "member" });

  // 2. Attested agents (owner != agent, scoped operations, real Ed25519 attestations)
  kernel.registerAgent(tenantId, {
    id: "fixer",
    owner: "ben",
    harness: "Claude Code",
    role: "worker",
    scope: [
      "chat.post",
      "task.claim",
      "task.renew",
      "task.submit",
      "patch:fix/*",
      "effect:open-pr",
      "effect:open-branch",
      "effect:post-slack",
    ],
  });

  kernel.registerAgent(tenantId, {
    id: "codex",
    owner: "ben",
    harness: "Codex",
    role: "worker",
    scope: [
      "chat.post",
      "task.claim",
      "task.renew",
      "task.submit",
      "patch:fix/*",
      "effect:open-pr",
      "effect:open-branch",
    ],
  });

  kernel.registerAgent(tenantId, {
    id: "verifier",
    owner: "ana",
    harness: "Clean Sandbox Runner",
    role: "verifier",
    scope: ["task.verify", "chat.post"],
  });

  kernel.registerAgent(tenantId, {
    id: "goose-triage",
    owner: "ana",
    harness: "Goose ACP",
    role: "reviewer",
    scope: ["chat.post", "task.triage", "task.create"],
  });

  kernel.registerAgent(tenantId, {
    id: "sec-scan",
    owner: "ana",
    harness: "Mastra",
    role: "worker",
    scope: ["chat.post", "task.create", "task.claim", "task.submit"],
  });

  // 3. Board-style hierarchical channel grants
  kernel.createGrant(tenantId, "ana", {
    id: "g1",
    principal: "everyone",
    path: "dev/",
    can: ["all"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g2",
    principal: "everyone",
    path: "prs/",
    can: ["all"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g3",
    principal: "everyone",
    path: "incidents/",
    can: ["all"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g4",
    principal: "everyone",
    path: "branch/",
    can: ["all"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g5",
    principal: "everyone",
    path: "security/",
    can: ["none"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g6",
    principal: "ana",
    path: "security/",
    can: ["all"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g7",
    principal: "ben",
    path: "security/",
    can: ["all"],
  });
  kernel.createGrant(tenantId, "ana", {
    id: "g8",
    principal: "sec-scan",
    path: "security/",
    can: ["read", "post"],
  });

  // 4. Schema registry
  kernel.registerSchema(tenantId, {
    name: "security-finding@1",
    description: "Structured security vulnerability finding emitted by scanner agents.",
    required: ["repository", "severity", "status"],
    enums: {
      severity: ["low", "medium", "high", "critical"],
      status: ["open", "triaged", "fixed"],
    },
  });

  // 5. Base channels
  for (const ch of ["dev", "prs", "incidents", "security"]) {
    kernel.ensureChannelRoom(tenantId, { name: ch, createdBy: "ana" });
  }

  // 6. Seed historical incident memory (searchable via FTS5!)
  kernel.postChannelMessage(tenantId, {
    actor: "ben",
    channel: "incidents",
    text: "Historical note (PR #4120): Safari 16 form-submit 500s were caused by missing requestSubmit polyfill on payment forms.",
  });

  // 7. Ingest customer Slack bug -> typed task #801 (touches payments/* => SHA-bound human gate!)
  const slackReport = kernel.ingestMessage(tenantId, {
    source: "slack",
    principalId: "dana",
    channel: "dev",
    externalRef: "slack:C04/171.2",
    text: "Checkout 'Pay now' button is unresponsive on Safari 17.4. Repro: add item → checkout → click Pay now.",
  });

  kernel.createTask(tenantId, {
    id: "801",
    actor: "ingest",
    channel: "dev",
    title: "Checkout 'Pay now' unresponsive on Safari 17.4",
    protectedPath: "payments/checkout.ts",
    budgetCapCents: 500,
    labels: { kind: "bug", area: "checkout", severity: "P1" },
    fromInbound: slackReport,
    originOperationId: "slack:C04/171.2",
  });

  // 8. Dependent rollout verification task #803 (blocked until #801 reaches VerifiedClose!)
  kernel.createTask(tenantId, {
    id: "803",
    actor: "ben",
    channel: "dev",
    title: "Post-merge canary audit for Safari 17 checkout (#801)",
    deps: ["801"],
    budgetCapCents: 300,
    labels: { kind: "review", area: "checkout" },
  });

  // 9. Second ready bug #804 (no protected path -> auto-merges upon clean-sandbox verification!)
  kernel.createTask(tenantId, {
    id: "804",
    actor: "ben",
    channel: "dev",
    title: "Flaky e2e: cart-persistence.spec hydration race",
    budgetCapCents: 400,
    labels: { kind: "bug", area: "cart" },
  });

  // 10. Structured security finding in locked security/ channel
  kernel.postChannelMessage(tenantId, {
    actor: "sec-scan",
    channel: "security",
    text: "Unsanitised `q` parameter reaches raw query builder in /api/search.",
    schema: "security-finding@1",
    data: {
      repository: "acme/web",
      severity: "high",
      status: "open",
    },
  });

  kernel.createTask(tenantId, {
    id: "810",
    actor: "sec-scan",
    channel: "security",
    title: "SQL injection risk in /api/search",
    protectedPath: "security/search.ts",
    budgetCapCents: 600,
    labels: { kind: "finding", severity: "high" },
  });

  // 11. Initial signed Merkle checkpoint
  kernel.createCheckpoint(tenantId);
}
