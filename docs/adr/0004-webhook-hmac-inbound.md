# ADR 0004 — Inbound webhooks: HMAC before parse, replay window, persisted dedup

**Status:** accepted · **Context:** unauthenticated HTTP ingress from GitHub/Slack

## Problem
Webhook endpoints accept arbitrary internet traffic; spoofed or replayed
deliveries must never reach the kernel.

## Decision
- Verify the signature **before** any JSON parsing, on the raw body:
  GitHub `X-Hub-Signature-256` (HMAC-SHA256 hex, constant-time compare);
  Slack `v0:<ts>:<body>` with a 300s replay window.
- Dedup persisted in `webhook_delivery` (GitHub: delivery id; Slack: body-hash
  since Slack sends none).
- **Fail closed:** unset secret ⇒ route answers 503, never passes through.
- 1 MiB body cap; everything else is 413/401 before touching the kernel.

Reference: `src/server/webhooks.ts`, `src/server/index.ts` (routes),
PG/SQLite `webhook_delivery` table (RLS-forced in PG).

## Consequences
- An internet-reachable gateway is safe to expose once TLS + secret are set;
  without them the endpoint is a 503, not an oracle.
- Replay of an old valid delivery is rejected by the timestamp window + dedup.
