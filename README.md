# Hive

> **Where humans and agents share a room — and who keeps it honest.**

Hive is a fenced, verified agent coordination plane combining **Vercel Board**'s coordination primitives (tasks, leases, dependencies, watchers, path grants, structured schemas, two-way Slack/GitHub projections) with **Buzz**'s cryptographic event architecture (keypair identities, Owner Attestations, branch-as-room NIP-34 patches, unified full-text search, and a SHA-256 hash-chained signed event log) — hardened around a transactional **Authority Kernel**.

See [`ARCHITECTURE_REVIEW.md`](./ARCHITECTURE_REVIEW.md) for the full end-to-end architectural and security review of the design specification.

---

## Core Invariants Implemented

1. **Projection ≠ Authority**: Chat messages (`"Fixed ✅"`), Slack mirrors, and branch rooms are read projections. Only typed CAS commands against `HiveKernel` mutate task state.
2. **Claim ≠ Lease (`lease_epoch` Fencing)**: Every task write and agent outbox effect is guarded by `CapabilityToken` verification + server-side `lease_epoch` CAS. Stale/zombie workers receive `409 FENCED` (`fence.rejected` logged).
3. **Independent `VerifiedClose`**: Tasks close only with a clean-sandbox `Evidence` receipt produced by a non-author verifier principal (`author !== verifier`). Dependent tasks unblock strictly on `VerifiedClose`.
4. **Capabilities & Trust over Wording**: Inbound external messages are labelled `{source, principal, trust}` and wrapped in `<untrusted>` tags; prompt-injection spans are quarantined and outbound DLP blocks secret exfiltration (`sk_live_*`, `AKIA*`, `ghp_*`, PEM keys).
5. **SHA-Bound Human Gates (TOCTOU-Safe)**: Protected paths (`payments/*`, `security/*`) require Ed25519-signed human approvals bound to `head_sha`. Pushing a new commit automatically voids prior approvals and forces clean-sandbox re-verification.
6. **Fenced Idempotent Outbox**: External effects (`open-pr`, `merge`, `post-slack`, `post-github`, `open-branch`) execute through `outbox` with idempotency keys and read-after-write reconciliation.
7. **Budget Meter & Loop Circuit Breaker**: Per-task spend caps and 6× repeated failure-signature loop detection halt runaway agents (`423 HALTED`) until a human executes `/resume <id> --cap <$>`.
8. **Local SQLite WAL ⇄ Cloud Postgres 16 RLS + PITR Safety**: Identical multi-tenant default-deny isolation in SQLite (`node:sqlite` + FTS5) and Postgres 16 (`FORCE ROW LEVEL SECURITY`), with DB `incarnation` rotation invalidating pre-restore tokens on PITR recovery.

---

## Quick Start

```bash
# Install dependencies
npm install

# Run all 12 acceptance specs (10 chaos + 2 live-integration against mock GitHub/Slack)
npm test

# Start the HTTP Authority Server (port 8787) + Vite Web UI (port 5173)
npm run dev

# Type-check & build production bundle
npm run build

# Verify Postgres 16 FORCE-RLS migration against a real database
# (docker compose up -d postgres first, or any Postgres 16 admin URL)
HIVE_PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run verify:postgres

# Backup/PITR restore drill against real DB files
npm run drill:backup

# Load canary for the running gateway (concurrency 32 x 8 rounds)
npm run smoke:load
```

**Going live with GitHub / Slack:** set `HIVE_GITHUB_REPO=owner/name` +
`HIVE_GITHUB_TOKEN` (or `gh auth login`) and/or `HIVE_SLACK_WEBHOOK_URL`
(or `HIVE_SLACK_BOT_TOKEN` + `HIVE_SLACK_CHANNEL`), then restart. Boot logs print
`[hive-integrations] mode=…` and the Live Hive page shows `github:live` /
`slack:live` pills. Set `HIVE_GATEWAY_TOKEN` to require bearer auth on the API.
See [`INFRASTRUCTURE.md`](./INFRASTRUCTURE.md) for the full runbook and honest
status of every review caveat, and [`.env.example`](./.env.example) for all variables.

---

## Using the `hive` CLI & Registered `/commands`

```bash
# Workspace status & incarnation
./bin/hive.mjs status

# List tasks, states, lease epochs, budgets & VerifiedClose receipts
./bin/hive.mjs task list

# Claim a task as @fixer -> mints Ed25519-signed CapabilityToken
HIVE_ACTOR=fixer ./bin/hive.mjs task claim 801

# Push a patch & submit for clean-sandbox verification
HIVE_ACTOR=fixer ./bin/hive.mjs patch push 801 --sha 3fa9c1
HIVE_ACTOR=fixer ./bin/hive.mjs task submit 801 --sha 3fa9c1 --evidence pr:4412,ci:14/14

# Run independent clean-sandbox verifier (@verifier != @fixer)
HIVE_ACTOR=verifier ./bin/hive.mjs verify 801 --sha 3fa9c1 --repro safari17 pass

# Cast signed SHA-bound human approval -> merges via outbox & issues VerifiedClose!
HIVE_ACTOR=ana ./bin/hive.mjs "/approve 801 --sha 3fa9c1"

# Verify SHA-256 hash chain + Ed25519 signatures + Merkle checkpoint
./bin/hive.mjs log verify --checkpoint latest
```

---

## Acceptance Test Matrix (`npm test`)

| Spec | Invariant Verified |
|---|---|
| `tests/fence.zombie.spec.ts` | Expired lease reassigned to epoch 2; zombie epoch-1 patch/submit/outbox calls return `409 FENCED` with 0 duplicate PRs |
| `tests/verify.falseclose.spec.ts` | Chat `"Fixed ✅"` never closes task; author self-verify returns `403`; broken patch rejected (`attempt+1`) |
| `tests/ingest.injection.spec.ts` | External Slack injection wrapped in `<untrusted>`, merge denied, outbound secret blocked by DLP |
| `tests/outbox.replay.spec.ts` | Crash between GitHub PR creation and ack reconciles via read-back on retry (`1 PR`, `0` duplicates) |
| `tests/budget.breaker.spec.ts` | 6× repeated failing call signature halts task (`423 HALTED`); human `/resume 801 --cap 8` recovers |
| `tests/gate.sha.spec.ts` | Unapproved merge & agent approval blocked; post-approval commit push voids approval & forces re-verify |
| `tests/log.tamper.spec.ts` | Direct SQLite row edit caught by `verifyLog` at exact tampered `seq` |
| `tests/authority.pitr.spec.ts` | SQLite PITR snapshot restore rotates `incarnation` and rejects post-snapshot tokens (`409`) |
| `tests/rls.isolation.spec.ts` | Empty tenant context denied (`403`); cross-tenant queries & tokens strictly isolated |
| `tests/wake.redeliver.spec.ts` | Dropped wake redelivered; `ackWake` cursor is idempotent; dependent task `#803` unblocks only on `VerifiedClose` |
| `tests/integrations.spec.ts` | Kernel outbox → **live-wired** GitHub/Slack gateways (mock providers on 127.0.0.1): idempotent PR creation, merge/branch/comment read-back reconciliation, Slack ledger dedupe, DLP failure marking, `HIVE_INTEGRATIONS` mode resolution |
