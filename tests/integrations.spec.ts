/**
 * Live integration gateway tests — NO real external network.
 *
 * Mock GitHub + mock Slack run as a SEPARATE PROCESS (tests/mock-integration-servers.mjs)
 * because the kernel's effect path performs synchronous HTTP via execFileSync — an
 * in-process mock server would deadlock the event loop (and did, in the first version).
 *
 * Covers: open-pr through the real outbox + capability token, idempotent replay,
 * read-after-write reconciliation on a fresh key, merge, open-branch, comment marker
 * reconciliation, Slack webhook post + replay, ledger read-back, DLP failure marking,
 * and HIVE_INTEGRATIONS mode resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { resolveEffectHub, integrationStatus } from "../src/integrations";
import type { EffectLedger } from "../src/integrations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SCRIPT = path.join(__dirname, "mock-integration-servers.mjs");

interface MockPorts {
  github: number;
  slack: number;
}

async function startMocks(): Promise<{ ports: MockPorts; child: ChildProcess }> {
  const child = spawn(process.execPath, [MOCK_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ports = await new Promise<MockPorts>((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("mock servers did not become ready in 10s")), 10_000);
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      const line = buf.split("\n").find((l) => l.startsWith("PORTS "));
      if (line) {
        clearTimeout(to);
        resolve(JSON.parse(line.slice("PORTS ".length)) as MockPorts);
      }
    });
    child.on("exit", (code) => reject(new Error(`mock servers exited early (${code})`)));
    child.on("error", reject);
  });
  return { ports, child };
}

async function mockState(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/__state`);
  return (await res.json()) as Record<string, unknown>;
}

const ENV_KEYS = [
  "HIVE_INTEGRATIONS",
  "HIVE_GITHUB_API_URL",
  "HIVE_GITHUB_REPO",
  "HIVE_GITHUB_TOKEN",
  "HIVE_GITHUB_USE_GH_CLI",
  "HIVE_SLACK_WEBHOOK_URL",
  "HIVE_SLACK_BOT_TOKEN",
  "HIVE_SLACK_CHANNEL",
  "HIVE_SLACK_API_URL",
  "HIVE_GATEWAY_TOKEN",
];

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
  return () => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("integrations.spec — kernel outbox drives LIVE GitHub + Slack mocks with idempotent replay & read-back", async () => {
  const { ports, child } = await startMocks();
  const ghUrl = `http://127.0.0.1:${ports.github}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-integrations-"));
  const ledgerFile = path.join(tmp, "ledger.jsonl");
  const restore = withEnv({
    HIVE_INTEGRATIONS: "auto",
    HIVE_GITHUB_API_URL: ghUrl,
    HIVE_GITHUB_REPO: "acme/www",
    HIVE_GITHUB_TOKEN: "test-token",
    HIVE_GITHUB_USE_GH_CLI: "0",
    HIVE_SLACK_WEBHOOK_URL: `http://127.0.0.1:${ports.slack}/hook`,
    HIVE_SLACK_CHANNEL: "#triage",
  });

  try {
    const hub = resolveEffectHub(process.env, ledgerFile);
    const status = integrationStatus(process.env);
    assert.equal(status.github.mode, "live");
    assert.equal(status.slack.mode, "live");
    assert.equal(status.gatewayAuth, "open-dev");

    const kernel = new HiveKernel(undefined, hub);
    seedWorkspace(kernel, DEFAULT_TENANT);

    // ── open-pr through the real outbox + capability token ───────────────
    const claim = kernel.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer", ttlMs: 10 * 60 * 1000 });
    const key = `task:801/ep:${claim.epoch}/open-pr`;
    const pr = kernel.runEffect(DEFAULT_TENANT, {
      key,
      effect: "open-pr",
      taskId: "801",
      token: claim.token,
      args: { taskId: "801", repo: "acme/www", branch: "fix/task-801", headSha: "deadbeef1234", title: "Fix checkout submit on Safari 17" },
    });
    assert.equal(pr.via, "github-api");
    let gh = (await mockState(ports.github)) as {
      pullsPost: number;
      mergePut: number;
      commentsPost: number;
      refsPost: number;
      prs: Array<{ number: number }>;
    };
    assert.equal(gh.pullsPost, 1);
    const prNumber = Number(pr.prNumber);
    assert.ok(prNumber >= 4413);

    // Idempotent replay: same key → outbox confirmed cache, NO second POST
    const prReplay = kernel.runEffect(DEFAULT_TENANT, {
      key,
      effect: "open-pr",
      taskId: "801",
      token: claim.token,
      args: { taskId: "801", repo: "acme/www", branch: "fix/task-801", headSha: "deadbeef1234", title: "Fix checkout submit on Safari 17" },
    });
    gh = (await mockState(ports.github)) as typeof gh;
    assert.equal(gh.pullsPost, 1);
    assert.deepEqual(prReplay, pr);

    // Read-back reconciliation on a FRESH key (crash-after-perform, before the
    // outbox row was confirmed): must NOT create a duplicate PR.
    const reconciled = hub.findExisting(
      DEFAULT_TENANT,
      "open-pr",
      { repo: "acme/www", branch: "fix/task-801", taskId: "801" },
      "fresh-key-after-crash",
    );
    assert.ok(reconciled);
    assert.equal(reconciled.prNumber, prNumber);
    assert.equal(reconciled.reconciledViaReadBack, true);
    gh = (await mockState(ports.github)) as typeof gh;
    assert.equal(gh.pullsPost, 1);

    // Outbox row for the original key is confirmed with via=github-api receipt
    const outbox = kernel.listOutbox(DEFAULT_TENANT).find((o) => o.idempotencyKey === key);
    assert.equal(outbox?.status, "confirmed");

    // ── GitHub gateway: merge + open-branch ──────────────────────────────
    const mergeReceipt = hub.perform(DEFAULT_TENANT, "merge", { prNumber, headSha: "deadbeef1234" }, "merge-key-1");
    assert.equal(mergeReceipt.mergeSha, `merge-${prNumber}-squashed`);
    const mergeReconciled = hub.findExisting(DEFAULT_TENANT, "merge", { prNumber }, "merge-key-2");
    assert.equal(mergeReconciled?.mergeSha, `merge-${prNumber}-squashed`);
    gh = (await mockState(ports.github)) as typeof gh;
    assert.equal(gh.mergePut, 1);

    hub.perform(DEFAULT_TENANT, "open-branch", { branch: "fix/task-coverage", repo: "acme/www" }, "branch-key-1");
    const branchReconciled = hub.findExisting(DEFAULT_TENANT, "open-branch", { branch: "fix/task-coverage" }, "branch-key-2");
    assert.equal(branchReconciled?.branch, "fix/task-coverage");
    gh = (await mockState(ports.github)) as typeof gh;
    assert.equal(gh.refsPost, 1);

    // comment marker reconciliation
    hub.perform(DEFAULT_TENANT, "post-github", { prNumber, body: "Autonomous fix verified on Safari 17" }, "comment-key-1");
    const commentReconciled = hub.findExisting(DEFAULT_TENANT, "post-github", { prNumber }, "comment-key-1");
    assert.equal(commentReconciled?.commentId, "1000");
    gh = (await mockState(ports.github)) as typeof gh;
    assert.equal(gh.commentsPost, 1);

    // ── Slack webhook through the real outbox ────────────────────────────
    const slackReceipt = kernel.runEffect(DEFAULT_TENANT, {
      key: "task:801/notif/slack",
      effect: "post-slack",
      args: { channel: "#triage", text: "checkout fix verified on Safari 17" },
      token: claim.token,
    });
    assert.equal(slackReceipt.via, "slack-webhook");
    let slack = (await mockState(ports.slack)) as { webhookPosts: string[] };
    assert.equal(slack.webhookPosts.length, 1);
    assert.ok(slack.webhookPosts[0].includes("checkout fix verified"));
    assert.ok(slack.webhookPosts[0].includes("[hive:task:801/notif/slack]"));

    // Replay: same outbox key → no second webhook post
    kernel.runEffect(DEFAULT_TENANT, {
      key: "task:801/notif/slack",
      effect: "post-slack",
      args: { channel: "#triage", text: "checkout fix verified on Safari 17" },
      token: claim.token,
    });
    slack = (await mockState(ports.slack)) as typeof slack;
    assert.equal(slack.webhookPosts.length, 1);

    // Ledger read-back (covers Slack's missing provider-side idempotency)
    const slackLedger = hub.findExisting(
      DEFAULT_TENANT,
      "post-slack",
      { channel: "#triage", text: "checkout fix verified on Safari 17" },
      "task:801/notif/slack",
    );
    assert.equal(slackLedger?.via, "ledger");

    // ── DLP failure marks the outbox row failed; no side effect posted ────
    assert.throws(
      () =>
        kernel.runEffect(DEFAULT_TENANT, {
          key: "task:801/secret-leak",
          effect: "post-slack",
          args: { channel: "#triage", text: "deploy key sk_live_abcdefghijklmnop" },
          token: claim.token,
        }),
      /DLP|secret/i,
    );
    slack = (await mockState(ports.slack)) as typeof slack;
    assert.equal(slack.webhookPosts.length, 1);
    const leakRow = kernel.listOutbox(DEFAULT_TENANT).find((o) => o.idempotencyKey === "task:801/secret-leak");
    assert.equal(leakRow?.status, "failed");

    // Ledger is append-only JSONL and parseable
    const ledgerLines = fs.readFileSync(ledgerFile, "utf8").trim().split("\n");
    assert.ok(ledgerLines.length >= 5);
    for (const line of ledgerLines) {
      const entry = JSON.parse(line) as EffectLedger & { effect: string };
      assert.ok(entry.effect);
    }
  } finally {
    restore();
    child.kill("SIGTERM");
  }
});

test("integrations.spec — mode resolution: auto falls back per-category; live fails fast without credentials", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-integrations-mode-"));
  const ledger = path.join(tmp, "ledger.jsonl");

  // auto with no creds → both simulation
  const restoreAuto = withEnv({});
  try {
    const hub = resolveEffectHub(process.env, ledger);
    const receipt = hub.perform("acme", "open-pr", { taskId: "901", branch: "fix/task-901" }, "sim-key");
    assert.equal(receipt.via, undefined); // simulated receipts carry no via marker
    assert.ok(Number(receipt.prNumber) >= 4412);
  } finally {
    restoreAuto();
  }

  // live with nothing configured → hard error naming what is missing
  const restoreLive = withEnv({ HIVE_INTEGRATIONS: "live" });
  try {
    assert.throws(() => resolveEffectHub(process.env, ledger), /HIVE_INTEGRATIONS=live but GitHub is not configured/);
  } finally {
    restoreLive();
  }

  // live with github only → hard error on slack
  const restoreSlack = withEnv({
    HIVE_INTEGRATIONS: "live",
    HIVE_GITHUB_REPO: "acme/www",
    HIVE_GITHUB_TOKEN: "x",
    HIVE_GITHUB_USE_GH_CLI: "0",
  });
  try {
    assert.throws(() => resolveEffectHub(process.env, ledger), /Slack is not configured/);
  } finally {
    restoreSlack();
  }

  // status endpoint never throws, even on invalid mode
  const restoreStatus = withEnv({ HIVE_INTEGRATIONS: "bogus" });
  try {
    const status = integrationStatus(process.env);
    assert.equal(status.github.mode, "simulation");
    assert.match(status.note, /Integration resolution failed|must be/);
  } finally {
    restoreStatus();
  }
});
