/**
 * Inbound webhook verification + replay protection (H7).
 *
 * - GitHub: `X-Hub-Signature-256: sha256=<hex>` over the RAW body, HMAC-SHA256
 *   with HIVE_GITHUB_WEBHOOK_SECRET. `X-GitHub-Delivery` is the dedup key.
 * - Slack: `X-Slack-Signature: v0=<hex>` over `v0:<timestamp>:<raw body>`,
 *   HMAC-SHA256 with HIVE_SLACK_SIGNING_SECRET. Timestamps older than 300s are
 *   rejected; deliveries are deduped on a body hash (Slack sends no delivery id).
 * - All comparisons are constant-time (timingSafeEqual). Verification happens
 *   BEFORE any JSON parsing. Dedup is persisted in `webhook_delivery`.
 *
 * An unset secret fails closed: the route answers 503, it never passes through.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const WEBHOOK_REPLAY_WINDOW_MS = 300_000; // 300s
export const WEBHOOK_BODY_CAP_BYTES = 1024 * 1024; // 1 MiB

function hmacSha256(secret: string, payload: string | Buffer): Buffer {
  return crypto.createHmac("sha256", secret).update(payload).digest();
}

function safeEqualHex(expected: Buffer, presented: string): boolean {
  if (!/^[0-9a-f]+$/i.test(presented)) return false;
  const presentedBuf = Buffer.from(presented, "hex");
  if (presentedBuf.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, presentedBuf);
}

export interface WebhookCheck {
  ok: boolean;
  error?: string;
  deliveryId?: string;
  status: number;
}

export function verifyGitHubWebhook(
  secret: string | undefined,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  deliveryHeader: string | undefined,
): WebhookCheck {
  if (!secret) {
    return { ok: false, error: "HIVE_GITHUB_WEBHOOK_SECRET is not configured", status: 503 };
  }
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader ?? "");
  if (!m) {
    return { ok: false, error: "missing or malformed X-Hub-Signature-256", status: 401 };
  }
  const expected = hmacSha256(secret, rawBody);
  if (!safeEqualHex(expected, m[1])) {
    return { ok: false, error: "invalid X-Hub-Signature-256", status: 401 };
  }
  const deliveryId =
    deliveryHeader && deliveryHeader.trim().length > 0 && deliveryHeader.length <= 128
      ? deliveryHeader.trim()
      : `body:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
  return { ok: true, deliveryId, status: 200 };
}

export function verifySlackWebhook(
  secret: string | undefined,
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  nowMs: number = Date.now(),
): WebhookCheck {
  if (!secret) {
    return { ok: false, error: "HIVE_SLACK_SIGNING_SECRET is not configured", status: 503 };
  }
  const tsSec = Number(timestampHeader ?? "");
  if (!Number.isFinite(tsSec) || tsSec <= 0) {
    return { ok: false, error: "missing or malformed X-Slack-Request-Timestamp", status: 401 };
  }
  const skewMs = Math.abs(nowMs - tsSec * 1000);
  if (skewMs > WEBHOOK_REPLAY_WINDOW_MS) {
    return { ok: false, error: "stale X-Slack-Request-Timestamp (replay window 300s)", status: 401 };
  }
  const base = `v0:${timestampHeader}:${rawBody.toString("utf8")}`;
  const expected = hmacSha256(secret, base);
  const m = /^v0=([0-9a-f]{64})$/i.exec(signatureHeader ?? "");
  if (!m) {
    return { ok: false, error: "missing or malformed X-Slack-Signature", status: 401 };
  }
  if (!safeEqualHex(expected, m[1])) {
    return { ok: false, error: "invalid X-Slack-Signature", status: 401 };
  }
  // Slack provides no delivery id; dedup on (channel-agnostic) body hash + ts.
  const deliveryId = `slack:${crypto
    .createHash("sha256")
    .update(String(timestampHeader) + rawBody)
    .digest("hex")}`;
  return { ok: true, deliveryId, status: 200 };
}

/**
 * Record a delivery. Returns true when this is the FIRST delivery (caller may
 * process), false when it is a replay (caller must short-circuit with 200).
 */
export function claimWebhookDelivery(
  db: DatabaseSync,
  tenantId: string,
  source: "github" | "slack",
  deliveryId: string,
  nowMs: number = Date.now(),
): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_delivery (delivery_id, tenant_id, source, received_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`${source}:${deliveryId}`, tenantId, source, nowMs);
  return Number(res.changes) === 1;
}
