# Hive — Infrastructure & Integration Runbook

Status of every item from the post-build review, what was done, what is
**verified**, and what you must supply. Last updated: 2026-11-25.

> **Tracked work:** the open items in this file are actionable backlog in [`TODO.md`](./TODO.md).

---

## 1. Postgres 16 (`001_postgres_rls.sql`) — ✅ APPLIED & VERIFIED IN-SANDBOX · CI tracked

- The migration was applied to a **real PostgreSQL 16.2** (user-space `pgserver`
  wheel, unix socket) and exercised by `scripts/verify-postgres-rls.mjs`, which:
  recreates a throwaway database (`hive_rls_verify`, dropped afterwards), applies the
  migration twice (idempotent), grants least-privilege rights to a **non-superuser**
  role `hive_rls_app`, seeds two tenants, and asserts **27/27 checks**:
  ENABLE + FORCE RLS on all 14 tenant tables, default-deny (unset *and* empty
  `app.tenant_id`), cross-tenant SELECT/UPDATE/DELETE isolation, `WITH CHECK` insert
  denial, FTS5/GIN `tsvector` scoping, and read-only `authority_meta` bootstrap.
- **Run it yourself:** `docker compose up -d postgres` then
  `HIVE_PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run verify:postgres`
  (in-sandbox invocation used a unix socket: `HIVE_PG_ADMIN_URL='postgresql://postgres:@/postgres?host=<socketdir>'`).
- CI (`.github/workflows/ci.yml`, job `postgres-rls`) re-runs the identical check
  on every push against a `postgres:16-alpine` service.
- **Honesty note:** the verification proves the *schema and isolation semantics*.
  The running kernel still persists through `node:sqlite` locally; a `pg`-backed
  store implementing the same `assertTenant` contract is the natural next step —
  the RLS DDL is ready for it, and the verify script is the acceptance gate.

## 2. External integrations (GitHub / Slack) — ✅ WIRED, LIVE-TESTED AGAINST MOCKS, CREDENTIALS REQUIRED FOR REAL API

Implemented in `src/integrations/` and composed by `LiveEffectConnectorHub`
into the **same** outbox path the 10 chaos specs exercise:

- `github.ts` — live `open-pr` / `merge` / `post-github` / `open-branch` against the
  REST API with **provider-side read-after-write reconciliation** (PR by head branch,
  merged state, comment scan for `<!-- hive-idem:<key> -->`, git-ref existence).
  Crash after perform → retry replays into the existing PR, never a duplicate.
- `slack.ts` — `post-slack` via incoming webhook (`HIVE_SLACK_WEBHOOK_URL`) or
  Web API `chat.postMessage` (`HIVE_SLACK_BOT_TOKEN` + `HIVE_SLACK_CHANNEL`).
  Slack has no idempotency key — mitigations: append-only ledger
  (`.hive/live-ledger.jsonl` via `EffectLedger`) + `[hive:<key>]` marker embedded in
  every message so duplicates are detectable. Documented residual risk: no
  exactly-once guarantee without a queue worker.
- Mode resolution (`HIVE_INTEGRATIONS`): `auto` (default, per-category fallback) ·
  `live` (fail fast at boot if GitHub or Slack unresolvable) · `simulation`
  (never touches network). A configured-live category **never silently falls back**
  — network failure marks the outbox row `failed` and it stays retryable.
- **Verified by `tests/integrations.spec.ts`** (runs in `npm test`, 16/16 green):
  mock GitHub + mock Slack on 127.0.0.1 *as separate processes* (the kernel's
  effect path is synchronous curl — in-process mocks deadlock). Covers outbox-confirmed
  PR creation, idempotent replay (1 POST only), fresh-key read-back after a simulated
  crash, merge reconciliation, branch creation, comment marker reconciliation, Slack
  post/replay, ledger read-back, DLP failure marking (`sk_live_*` blocked, outbox row
  `failed`, zero side effect), and `HIVE_INTEGRATIONS` mode resolution.
- **To go live, you must supply** (see `.env.example`): `HIVE_GITHUB_REPO=owner/name`
  + `HIVE_GITHUB_TOKEN` (or set `HIVE_GITHUB_USE_GH_CLI=1` to opt into reading `gh auth token`)
  and/or `HIVE_SLACK_WEBHOOK_URL` (or bot token + channel). Then restart; boot log
  prints `[hive-integrations] …` with the resolved mode for each category, and the
  **Live Hive** page shows `github:live` / `slack:live` pills (top status bar).
  `GET /api/integrations/status` reports modes (never secrets).
- **Honest limitation:** the live path was verified against mocks + API-shape review,
  not against real GitHub/Slack — the sandbox allowlist blocks `api.slack.com`/`slack.com`,
  and no user-provided GitHub token/repo exists yet. The first real call is one env var away.
- **Inbound webhooks (2026-11-26):** `POST /api/webhooks/github` and `POST /api/webhooks/slack`
  verify HMAC-SHA256 signatures (`X-Hub-Signature-256` / `v0=` scheme) with `timingSafeEqual`
  **before parsing**, enforce a 300s replay window on Slack timestamps, dedup deliveries via the
  `webhook_delivery` table, and ingest into `HIVE_WEBHOOK_TENANT` as quarantined external
  messages (`HIVE_WEBHOOK_CHANNEL`). An unset webhook secret fails closed (503). Request bodies
  are capped at 1 MiB (413). Nothing is registered on a public URL yet — that needs §5.

## 3. Browser-level QA — ⚠️ NOT PERFORMED IN-SANDBOX (no browser binary exists here)

- No Chromium/Chrome is installed or downloadable in this sandbox (browser CDNs are
  outside the network allowlist). `npm run build` is green; every `/api/*` endpoint
  the UI calls was `curl`-verified (200s + correct payloads); React renders were
  **not** visually inspected.
- Mitigations shipped: `dist/` production build works, Vite preview config in place,
  all data hooks error-contain, integrations pill degrades silently if `/api` 401s.
- What you should do before trusting the UI: `npm run dev`, open
  `http://localhost:5173`, click through the tabs, run a drill or two. Any defect you
  hit is almost certainly in `src/web/LiveHivePage.tsx`. CI could run Playwright on
  GitHub-hosted runners (they can download browsers) — say the word and I'll add it.

## 4. Prototype reference tabs — ✅ DOCUMENTED AS PROTOTYPES

- `Board`, `Buzz`, `Combined` tabs remain the original artifact prototypes with
  in-memory toy engines (`src/proto/*`). Only the `Live Hive` tab talks to the real
  kernel. Defects fixed in-place: 2-char search tokens, stale-reducer double-eval in
  `BuzzProto`. They are intentionally kept for side-by-side comparison with the
  live system; they will not persist anything anywhere.

## 5. Push / deploy — ✅ BRANCH PUSHED · Vercel ready, deploy not triggered (needs your go-ahead)

- Branch `arena/446b8aab-hive` is pushed to `origin` (security remediation commits:
  see `SECURITY_REMEDIATION_PLAN.md` execution log). PR #3 (remediation) opens on your go-ahead.
- `vercel.json` ships: Vite framework preset, `npm ci` install, `npm run build`,
  `dist` output, SPA fallback rewrites. **The static frontend deploys cleanly as-is.**
  What it does *not* get you: a reachable `/api` — Vercel serverless would need a
  `pg`-backed store + a managed Postgres (e.g. Neon) and a `VITE_HIVE_API_BASE`
  pointing at it. The Vercel connector here can create projects/env-vars/deployments
  but **cannot provision a database**.
- **To deploy the static UI now:** connect the GitHub repo in the Vercel dashboard
  (or ask me to run `create_project` + `create_deployment`), set env
  `VITE_HIVE_API_BASE` to your gateway origin.
- **To have a live backend**: run the gateway on any Node host (Railway/Fly/VM) with
  `HIVE_GATEWAY_TOKEN` set, Postgres 16 via `docker-compose.yml`, and the migration +
  `npm run verify:postgres` as your gate. Webhook ingestion then needs the gateway
  URL registered in GitHub/Slack. This is the recommended next milestone — it is
  intentionally not auto-deployed.

## 6. Production hardening — ✅ BASELINE + PHASE-0 REMEDIATION SHIPPED · residual items listed honestly

Shipped and verified in this pass (2026-11-26):
- **Per-principal sessions**: HTTP routes derive `(tenant, actor)` exclusively from
  `hst_<base64url(32B)>` sessions (SHA-256-hashed at rest in `principal_session`,
  12h default TTL, 24h cap, `timingSafeEqual` on hashes, `revoked` flag,
  `last_used_at`). Minting requires `HIVE_ADMIN_TOKEN` (≥32 chars; mandatory in
  production, else boot refuses). Body/query `actor` honored only under
  `HIVE_DEV_INSECURE_ACTOR=1` (loud boot warning; refused in production).
  `/api/state` no longer leaks `activeTokens`. `hct_` capability jar is keyed per
  session (200-entry LRU), never global per tenant.
- **Admin/drills gating**: `/api/reset` and `/api/scenario` return 403 unless
  `HIVE_ENABLE_DEV_DRILLS=1`; `/api/reset` additionally requires the admin token
  (fs.rmSync of the DB is no longer reachable unauthenticated).
- **Custodial keys**: `HIVE_MASTER_KEY` (AES-256-GCM) envelope-encrypts
  `principal.privkey` and `authority_meta.gateway_priv` at rest; legacy plaintext
  re-encrypts in place at boot; `HIVE_GATEWAY_SIGNING_KEY` overrides the DB copy for
  signing; required in production.
- **Commit-then-send outbox**: effects stage as `pending` inside the kernel
  transaction; DLP/read-after-write/perform run post-commit (`drainOutboxEffect`);
  a crashed drain is re-driven by `kernel.reconcileOutbox()` at server boot;
  confirmed merges close tasks stuck pre-`merged→closed`. Effect ledger is
  tenant-scoped.
- **Human authz hardening**: role-gated `task.verify` (owner|lead|security|verifier),
  `two_of_three` security gates require owner|lead|security, approver must hold
  channel `post` access, rejects invalidate outstanding approvals for the SHA,
  attestation revoke/restore restricted to the owning human or an `owner`,
  minted `hct_` ops are the intersection with Owner Attestation scope, agents are
  fenced out of tokenless `pushPatch`/`runEffect`/`postChannelMessage`.
- **Inbound webhook HMAC** (see §2) + 1 MiB body cap (413) + foreign-`Host` → 421
  (`HIVE_ALLOWED_HOSTS`, `GET /api/health` exempt) + CORS restricted to loopback
  origins (or `HIVE_ALLOWED_ORIGINS`), `Authorization` in Allow-Headers.

Shipped previously (baseline):
- **Gateway auth**: `HIVE_GATEWAY_TOKEN` — when set, all `/api/*` except
  `GET /api/health` require `Authorization: Bearer <token>` (verified live:
  401 without/with wrong token, 200 with, health stays open). The UI now also
  renders an explicit sign-in panel and a 401 banner (2026-11-26); full
  401/error-surface design is Phase 3 (H6).
- **Backup/PITR drill**: `npm run drill:backup` — seed → claim → snapshot → mutate →
  restore against real DB files; asserts incarnation rotation, pre-restore token
  rejection, `FTS5` survival, hash-chain verification. **All 6 checks pass.**
- **Load canary**: `npm run smoke:load` — 512 requests at concurrency 32:
  `/api/health` p50 ≈ 8ms; `/api/state` p50 ≈ 86ms, p95 ≈ 168ms (it re-verifies the
  full signed log + checkpoint per call by design — cache this before internet-scale).
- **Secrets**: `.env.example` is committed (`.gitignore` allows it via `!.env.example`) and
  documents every variable; no tokens are read from the repo; `.hive/` (live DB, WAL, ledger)
  and `*.db*` are git-ignored; `integrationStatus()` never emits secret values.
  (Two earlier drafts of this section claimed these without the `!.env.example` exception
  being present — corrected 2026-11-26.)
- **CI**: `.github/workflows/ci.yml` — `npm ci → build → test` (12 specs) +
  Postgres 16 RLS verification job.

Residual, not done (needs real infrastructure / decisions from you):
- No TLS termination or WAF on the gateway (front it with a proxy or platform that
  provides them; do not expose `:8787` raw to the internet).
- No per-identity rate limiting yet (Phase 1, H7/M: token buckets 6000 req/min).
- No secrets manager integration (Vault/SM/Doppler); env vars + KMS-backed key custody options.
- No queue worker for exactly-once external effects (Slack gap, see §2).
- No `pg`-backed runtime store (see §1); SQLite is single-process.
- `/api/state` re-verifies the full signed log per call (p95 ≈ 168ms) — incremental
  verification cache is Phase 1 (M2).
- No alerting/metrics (`call_telemetry` table is populated; nothing exports it yet).
- Backup cadence/retention is your job (`VACUUM INTO` snapshots are on-demand only).
