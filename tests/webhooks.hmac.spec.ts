import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { HiveStore } from "../src/kernel/db";
import {
  verifyGitHubWebhook,
  verifySlackWebhook,
  claimWebhookDelivery,
  WEBHOOK_REPLAY_WINDOW_MS,
} from "../src/server/webhooks";

const GH_SECRET = "github-webhook-secret-0123456789abcdef";
const SLACK_SECRET = "slack-signing-secret-0123456789abcdef";

test("webhooks.hmac.spec — HMAC verification, replay window, delivery dedup", () => {
  const store = new HiveStore(":memory:");

  // ── GitHub ────────────────────────────────────────────────────────────
  const ghBody = Buffer.from(JSON.stringify({ zen: "keep it logically awesome" }), "utf8");
  const ghSig = "sha256=" + crypto.createHmac("sha256", GH_SECRET).update(ghBody).digest("hex");

  const okGh = verifyGitHubWebhook(GH_SECRET, ghBody, ghSig, "delivery-1");
  assert.equal(okGh.ok, true);
  assert.equal(okGh.deliveryId, "delivery-1");

  // Wrong signature fails closed.
  const badSig = "sha256=" + "0".repeat(64);
  assert.equal(verifyGitHubWebhook(GH_SECRET, ghBody, badSig, "delivery-2").ok, false);
  // Tampered body fails even with a structurally valid header for another body.
  const sigForOther = "sha256=" + crypto.createHmac("sha256", GH_SECRET).update("{}").digest("hex");
  assert.equal(verifyGitHubWebhook(GH_SECRET, ghBody, sigForOther, "delivery-3").ok, false);
  // Malformed header fails.
  assert.equal(verifyGitHubWebhook(GH_SECRET, ghBody, "md5=abcd", "delivery-4").ok, false);
  // Unset secret fails closed with 503.
  assert.equal(verifyGitHubWebhook(undefined, ghBody, ghSig, "delivery-5").status, 503);

  // Delivery dedup: first claim succeeds, replay is rejected.
  const first = claimWebhookDelivery(store.db, "acme", "github", "delivery-1", 1000);
  const replay = claimWebhookDelivery(store.db, "acme", "github", "delivery-1", 2000);
  assert.equal(first, true);
  assert.equal(replay, false);
  // Delivery GUIDs are globally unique; dedup is by delivery_id across tenants.
  assert.equal(claimWebhookDelivery(store.db, "globex", "github", "delivery-1", 3000), false);

  // ── Slack ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const slackBody = Buffer.from("token=abc&channel_id=C123&text=hello&ts=1.2", "utf8");
  const slackTs = String(Math.floor(now / 1000));
  const slackSig =
    "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${slackTs}:${slackBody}`).digest("hex");

  const okSlack = verifySlackWebhook(SLACK_SECRET, slackBody, slackTs, slackSig, now);
  assert.equal(okSlack.ok, true);

  // Stale timestamp (outside the 300s replay window) fails.
  const staleTs = String(Math.floor((now - WEBHOOK_REPLAY_WINDOW_MS - 60_000) / 1000));
  const staleSig =
    "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${staleTs}:${slackBody}`).digest("hex");
  assert.equal(verifySlackWebhook(SLACK_SECRET, slackBody, staleTs, staleSig, now).ok, false);

  // Wrong signing secret / body fails.
  const wrongSig =
    "v0=" + crypto.createHmac("sha256", "wrong-secret").update(`v0:${slackTs}:${slackBody}`).digest("hex");
  assert.equal(verifySlackWebhook(SLACK_SECRET, slackBody, slackTs, wrongSig, now).ok, false);
  // Malformed signature header fails.
  assert.equal(verifySlackWebhook(SLACK_SECRET, slackBody, slackTs, "v0=zz", now).ok, false);
  // Unset secret fails closed with 503.
  assert.equal(verifySlackWebhook(undefined, slackBody, slackTs, slackSig, now).status, 503);

  // Slack dedup is body+timestamp scoped and tenant-aware.
  const tsNow = String(Math.floor(now / 1000));
  const firstSlack = claimWebhookDelivery(store.db, "acme", "slack", `body:${tsNow}`, now);
  const replaySlack = claimWebhookDelivery(store.db, "acme", "slack", `body:${tsNow}`, now);
  assert.equal(firstSlack, true);
  assert.equal(replaySlack, false);
});
