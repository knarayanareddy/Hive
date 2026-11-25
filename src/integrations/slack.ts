/**
 * Live Slack gateway for the Hive outbox `post-slack` effect.
 *
 * Two transports:
 *   1. Incoming webhook  — HIVE_SLACK_WEBHOOK_URL (no channel scope needed;
 *      posts to the channel the webhook is bound to)
 *   2. Web API           — HIVE_SLACK_BOT_TOKEN + HIVE_SLACK_CHANNEL
 *      (chat.postMessage; HIVE_SLACK_API_URL override exists for tests)
 *
 * Slack provides NO idempotency key for chat.postMessage. Read-back is
 * therefore the local append-only EffectLedger plus an `[hive:<key>]` marker
 * embedded in every message so duplicates are detectable. Outbox retries use
 * the ledger to avoid double-posting after a crash between "Slack 200" and
 * "outbox updated".
 */
import { enforceOutboundDlp } from "../kernel/policy";
import { httpSync } from "./httpSync";

export interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
  channel: string;
  apiUrl: string;
  transport: "webhook" | "chat";
}

export function slackFromEnv(
  env: Record<string, string | undefined> = process.env,
): SlackConfig | null {
  const webhookUrl = env.HIVE_SLACK_WEBHOOK_URL?.trim();
  const botToken = env.HIVE_SLACK_BOT_TOKEN?.trim();
  const channel = env.HIVE_SLACK_CHANNEL?.trim() || "#bugs";
  const apiUrl = (env.HIVE_SLACK_API_URL ?? "https://slack.com/api").replace(/\/+$/, "");
  if (webhookUrl) {
    return { webhookUrl, channel, apiUrl, transport: "webhook" };
  }
  if (botToken) {
    return { botToken, channel, apiUrl, transport: "chat" };
  }
  return null;
}

export function slackMarker(key: string): string {
  return `[hive:${key}]`;
}

export class SlackGateway {
  constructor(private readonly cfg: SlackConfig) {}

  public perform(effect: string, args: Record<string, unknown>, key: string): Record<string, unknown> {
    if (effect !== "post-slack") {
      throw new Error(`slack gateway does not handle effect: ${effect}`);
    }
    const channel = String(args.channel ?? this.cfg.channel);
    const text = String(args.text ?? "");
    enforceOutboundDlp(text);
    const stamped = `${text} ·${slackMarker(key)}`;

    if (this.cfg.transport === "webhook") {
      const res = httpSync({
        method: "POST",
        url: this.cfg.webhookUrl as string,
        body: { text: stamped },
        timeoutMs: 10_000,
      });
      if (res.status !== 200 || res.text.trim() !== "ok") {
        throw new Error(`slack webhook refused (${res.status}): ${res.text.slice(0, 300)}`);
      }
      return {
        effect: "post-slack",
        channel: `webhook:${channel}`,
        slackTs: `wh-${Date.now()}`,
        via: "slack-webhook",
      };
    }

    const res = httpSync({
      method: "POST",
      url: `${this.cfg.apiUrl}/chat.postMessage`,
      headers: { Authorization: `Bearer ${this.cfg.botToken}` },
      body: { channel, text: stamped },
      timeoutMs: 10_000,
    });
    const payload = (res.json ?? {}) as { ok?: boolean; ts?: string; error?: string };
    if (res.status !== 200 || !payload.ok) {
      throw new Error(`slack postMessage failed (${res.status}): ${payload.error ?? res.text.slice(0, 300)}`);
    }
    return {
      effect: "post-slack",
      channel,
      slackTs: payload.ts,
      via: "slack-chat",
    };
  }
}
