# Hive — Infrastructure & Integration Runbook

Status of every item from the post-build review, what was done, what is
**verified**, and what you must supply. Last updated: 2026-11-27.

> **Tracked work:** the open items in this file are actionable backlog in [`TODO.md`](./TODO.md).

---

## 1. Postgres 16 (`001_postgres_rls.sql`) — ✅ APPLIED & VERIFIED IN-SANDBOX · CI tracked

- The migration was applied to a **real PostgreSQL 16.2** (user-space `pgserver`
  wheel, unix socket) and exercised by `scripts/verify-postgres-rls.mjs`, which:
  recreates a throwaway database (`hive_rls_verify`, dropped afterwards), applies the
  migration twice (idempotent), grants least-privilege rights to a **non-superuser**
  role `hive_rls_app`, seeds two tenants, and asserts **28/28 checks** (incl. the `artifact` table):
  ENABLE + FORCE RLS on all 15 tenant tables, default-deny (unset *and* empty
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

Shipped in Phase 2 (2026-11-27, single-origin serve + streaming + SDK):
- **Single-origin topology (decision §2.3)** — the Node gateway now serves the Vite build
  from `dist/` (`HIVE_STATIC_DIR`, default `./dist`; `off` disables): same-origin API + UI on
  one port, SPA fallback for client routes, immutable caching for hashed `/assets/*`,
  `no-cache` index.html, `nosniff` + strict CSP (`default-src 'self'`) on every static
  response, path-traversal guard (403/404), `X-Forwarded-*` untouched. CORS complexity is
  now a no-op for the primary topology (the loopback allowlist remains for dev);
  `VITE_HIVE_API_BASE` is a documented (origin-only) escape hatch; `VITE_HIVE_API_TOKEN` was REMOVED — never bake a shared bearer into a public bundle.
  `npm run serve` builds and serves the whole product on :8787. Verified live: `/` 200 with
  CSP + nosniff, SPA fallback, traversal → 404, `/api/state` still 401 without a session.
- **SSE stream `GET /api/events`** — committed events only (fan-out happens post-commit via
  a store-level commit hook; rolled-back transactions emit nothing). Frames: `id: <seq>` +
  `event: event|ready|presence|watch_replaced|error`, `: ping` heartbeat every 15s, replay via
  `Last-Event-ID` header or `?lastEventId=` (resume after disconnect). Read-scoped per channel
  (`explainAccess … 'read'`), null-channel audit events visible to all tenant sessions (same
  visibility as `/api/state`). Caps: 20 streams/principal (429 past that, checked before the
  response opens), **agents: 1 live stream** — a new agent stream closes the old one with a
  `watch_replaced` frame. Verified live (curl): replay, live delivery (seq 31), agent replace,
  resume-from-seq. **Deliberate deviation:** non-goal to migrate the UI off request/response —
  the UI subscribes and debounce-refetches state (250ms), which is simpler and keeps the kernel
  response contract unchanged; events arrive with <100ms latency into that render.
- **Presence registry (60s grace)** — join/heartbeat(15s)/drop semantics; disconnected entries
  persist 60s for reconnect tolerance; swept by the outbox worker tick; fan-out as `presence`
  frames + `GET /api/presence` (session required). Entries listed as `connected: false` during
  grace (verified live).
- **Evidence artifact store** — `POST /api/artifacts` (raw bytes ≤ 25 MiB, `HIVE_ARTIFACT_MAX_BYTES`),
  content-addressed by sha256 (`INSERT OR IGNORE` dedupe), stored `.hive/artifacts/<xx>/<sha256>`
  with 0700/0600, DLP-scanned before hitting disk (secret-shaped bytes refused with 403),
  tenant-scoped index in SQLite (`artifact` table, RLS-forced in PG),
  `GET /api/artifacts[/<sha256>]` served with `Content-Security-Policy: sandbox` + `nosniff` +
  immutable cache; every read re-verifies the content hash (tamper → 500 ARTIFACT_CORRUPT).
  **S3 backend via `aws4fetch` not included** — the seam (`HIVE_ARTIFACT_DIR`) is documented;
  untested S3 code was rejected. Verified live: upload → head/get/list roundtrip.
- **Typed SDK `hive/sdk`** — `src/sdk/index.ts` → `dist-sdk/sdk/` via `npm run build:sdk`
  (`package.json` `exports["./sdk"]`). `HiveClient` with typed methods (`getState`, `cli`,
  `me`, `presence`, `artifactPut/Get`, async-generator `events()` consuming SSE with
  `Last-Event-ID` resume) and `withLeaseHeartbeat` (renews `hct_` every ttl/3 via the kernel
  renew path; renewal rotates the token; hook-driven, not prompt-driven). AbortSignal-safe.
  32/32 specs green incl. stubbed-fetch SSE parsing specs. Live smoke: me/state/artifact roundtrip OK.
- **Async outbox worker** — `processOutboxPending` per tenant every `HIVE_OUTBOX_POLL_MS` (1s):
  atomic claim (`UPDATE … SET status='sent', locked_by, locked_until WHERE … locked_until <= now`) —
  the *same* fence guards the inline drain, so a provider call happens at most once per claim
  window (SKIP-LOCKED semantics; on Postgres this becomes `FOR UPDATE SKIP LOCKED`).
  Retryable failures re-drain with exponential backoff (min(2^attempts, 60s)); DLP-blocked and
  max-attempts rows (default 8, `HIVE_OUTBOX_MAX_ATTEMPTS`) are terminal and never re-claimed.
  Inline drain kept as the CLI's deterministic fast path. Boot `reconcileOutbox` stays as the
  merged→closed safety net. Verified by `tests/outbox.worker.spec.ts` (crash-staged retry without
  duplicate PR, DLP terminality, attempt ceiling, lock fencing).
- **EffectLedger kept (deliberate deviation)** — Phase 0 planned its removal in Phase 2; live Slack
  still has no provider-side idempotency, and `findExisting('post-slack')` depends on the ledger
  when the marker search is unavailable (webhook transport). Deleting it now would trade a known,
  documented residual for silent double-posts. Revisit when the queue worker lands (Phase 3).
- **UI** — live badge + watcher count in the status bar (SSE-driven), debounced auto-refresh on
  every committed event; single-origin default means no `VITE_HIVE_API_*` needed.
- **Playwright ui-e2e wired into CI** (`.github/workflows/ci.yml`, job `ui-e2e`): build → gateway →
  chromium sign-in against the real kernel (asserts SPA headers, 401-without-session, board renders,
  zero page errors). **Not executed in this sandbox** (browser CDN is off-egress) — CI is the
  verification path; do not merge on red e2e.
- `scripts/smoke-load.mjs` gains a single-origin static drill; `npm run serve` documented.
- New specs: 17 → **32** (`streams`, `outbox.worker`, `artifacts`, `sdk`). Specs pin the sim clock via `tests/_setup.ts`.

Shipped in Phase 1 (2026-11-27, PR #3):
- **Incremental `verifyLog` verification cache** — result cached per
  `(tenant, selector, resolved checkpoint, mutationEpoch, incarnation, PRAGMA data_version)`;
  same-process mutations bump `mutationEpoch`, out-of-process writes (e.g. drill scripts on
  the same SQLite file) are caught by `data_version`; incarnation rotation (PITR/reset) also
  invalidates. Ed25519 `KeyObject`s and verdicts are memoized (cache keys include the
  signature, so a swapped signature never hits a cached verdict). Cache-invalidation drill:
  kernel-level spec `tests/kernel.verifylog_cache.spec.ts` (out-of-process tamper via a second
  connection + in-kernel tamper) and an opt-in `smoke-load.mjs` reset drill (both pass).
- **Domain-separated Merkle tree** — leaves `H(0x00 ‖ id)`, nodes `H(0x01 ‖ left ‖ right)`;
  leaf/node domains cannot collide (checkpoint verification hardened).
- **Event content hash v1** — `computeEventId` now hashes
  `sha256(canonicalJson({domain:"hive.event.v1", …including attest}))` instead of a
  pipe-joined preimage whose field-boundary ambiguity allowed preimage collisions across
  e.g. `actor="a|b", channel="c"` vs `actor="a", channel="b|c"`. **Breaking change**: event
  ids computed by earlier builds do not match; databases seeded before this change fail
  `verifyLog` and must be re-seeded/restored (no migration — pre-production; the demo DB
  was re-seeded). `attest` is now bound into the event id.
- **Checkpoint lower-bound + head binding** — `verifyLog` rejects a checkpoint claiming
  `uptoSeq` beyond the log end (tail-truncation suspected) and rejects a `headEventId`
  that doesn't match the event at `seq = uptoSeq`.
- **Per-identity token buckets** (in-memory ADR-0033 style) — 6000 req/min per identity
  (bearer/session-token hash, else client IP; `X-Forwarded-For` honored), 60 effect
  calls/min (CLI `effect run` lines, `/api/scenario`, `/api/chaos-run`); 429 +
  `Retry-After` + `retryAfterSeconds`; `/api/health` exempt; resets on restart.
- **Wall-clock default** — `HIVE_CLOCK_MODE=wall` (default) keeps real time flowing;
  leases/attestations expire wall-clock. `HIVE_CLOCK_MODE=sim` freezes time at the seeded
  `sim_now_ms` baseline (tests only; specs pin it via `tests/_setup.ts`). In wall mode
  `hive tick --advance` applies a process-local virtual offset (demo fast-forward; resets on
  restart, failing safe by making leases expire sooner).
- **`/api/state` ETag/304** — strong revalidation on workspace content (volatile `now`
  excluded from the hash); `If-None-Match` → 304 with `Cache-Control: no-cache`.
- **Dead `hrv_` revision tokens removed** (`issueRevisionToken`/`checkRevisionToken`/
  `RevisionToken`); PITR spec rewired to capability tokens (`IncarnationMismatchError`
  coverage unchanged). DLP is centralized in `policy.ts` (`enforceOutboundDlp` post-commit
  pre-send; failures mark the outbox row `failed`) and verified by specs
  (`ingest.injection.spec`, `integrations.spec`). Log-verification cost on `/api/state`
  is cached (see above).

Shipped previously (baseline):
- **Gateway auth**: `HIVE_GATEWAY_TOKEN` — when set, all `/api/*` except
  `GET /api/health` require `Authorization: Bearer <token>` (verified live:
  401 without/with wrong token, 200 with, health stays open). The UI now also
  renders an explicit sign-in panel and a 401 banner (2026-11-26); full
  401/error-surface design is Phase 3 (H6).
- **Backup/PITR drill**: `npm run drill:backup` — seed → claim → snapshot → mutate →
  restore against real DB files; asserts incarnation rotation, pre-restore token
  rejection, `FTS5` survival, hash-chain verification. **All 6 checks pass.**
- **Load canary**: `npm run smoke:load` — mints an `hst_` admin session, then hits
  `/api/health` and `/api/state`; includes an ETag/304 drill and an opt-in
  verifyLog-cache invalidation drill (`HIVE_SMOKE_ALLOW_RESET=1`, destructive: wipes and
  re-seeds the demo DB). 2026-11-27 measurement (128 requests @ concurrency 16,
  fresh server, warm verify cache): `/api/state` p50 ≈ 16ms, p95 ≈ 28–35ms — the
  ~168ms full re-verify is gone from the hot path, but the plan's `<25ms p95`
  target is not met under 16-way load yet (snapshot serialization dominates once
  verify is cached).
- **Secrets**: `.env.example` is committed (`.gitignore` allows it via `!.env.example`) and
  documents every variable; no tokens are read from the repo; `.hive/` (live DB, WAL, ledger)
  and `*.db*` are git-ignored; `integrationStatus()` never emits secret values.
  (Two earlier drafts of this section claimed these without the `!.env.example` exception
  being present — corrected 2026-11-26.)
- **CI**: `.github/workflows/ci.yml` — `npm ci → build → test` (17 specs) +
  Postgres 16 RLS verification job.

Residual, not done (needs real infrastructure / decisions from you):
- No TLS termination or WAF on the gateway (front it with a proxy or platform that
  provides them; do not expose `:8787` raw to the internet).
- Rate buckets are in-memory: limits reset on restart and are per-process (single-machine
  deployment; revisit with the PG runtime / multi-instance §1).
- verifyLog cache correctness rests on `mutationEpoch` + `PRAGMA data_version` + incarnation;
  it is not a substitute for treating the SQLite file as trusted single-process state.
- Event-id format v1 is a one-way door: old databases fail `verifyLog` (see above).
- No secrets manager integration (Vault/SM/Doppler); env vars + KMS-backed key custody options.
- No queue worker for exactly-once external effects (Slack gap, see §2) — Phase 2 added the
  fenced outbox *drain* worker; Slack exactly-once additionally needs provider-side read-back
  or a real queue (Phase 3), and the EffectLedger remains load-bearing meanwhile.
- No `pg`-backed runtime store (see §1); SQLite is single-process. SSE/presence/Artifact indexes
  are process-local (presence) or SQLite (artifact) — fine single-machine, not for multi-node.
- Presence is best-effort in-memory (no cross-node roster); 60s grace covers reconnects only.
- SSE caps are per-process; a horizontal gateway would need sticky sessions or a bus.
- No alerting/metrics (`call_telemetry` table is populated; nothing exports it yet).
- ui-e2e is CI-only (browser download blocked in the dev sandbox); it has not run here.
- Backup cadence/retention is your job (`VACUUM INTO` snapshots are on-demand only).
