# TODO — Open Infrastructure & Hardening Items

Tracked backlog for the four items from the post-build review that remain
genuinely open after PR #1. Each item is scoped to be picked up directly.

**How to read this file:** every item lists *why*, *what's blocking*, *concrete
steps*, and *acceptance criteria*. Status starts at `OPEN`; flip to `DONE` in the
same PR that closes it. Runbook context lives in [`INFRASTRUCTURE.md`](./INFRASTRUCTURE.md);
full review in [`ARCHITECTURE_REVIEW.md`](./ARCHITECTURE_REVIEW.md).

| # | Item | Status | Blocked by |
|---|------|--------|------------|
| 1 | Live GitHub / Slack credentials for outbox effects | OPEN | Needs real credentials (repo + tokens) |
| 2 | `pg`-backed runtime store for cloud parity | OPEN | Engineering decision + managed Postgres |
| 3 | Browser-level UI QA (Playwright) | CI job landed (PR #4); NOT yet run | Needs one green CI run |
| 4 | Deployment activation (single-origin gateway) | OPEN | Gateway host decision + your go-ahead (see note below) |

---

## 1 — Live GitHub / Slack credentials for outbox effects

**Why:** the outbox gateways (`src/integrations/`) are implemented, fail-closed
(`HIVE_INTEGRATIONS=live`), and tested against mock providers on 127.0.0.1 —
but have never executed against the real APIs. Until they do, PR creation,
merges, comments, branch rooms and Slack posts are simulated or mock-verified.

**Blocked by:** you — `api.slack.com`/`slack.com` are outside this sandbox's
egress allowlist, and no user-provided GitHub repo/token exists here.

**Steps:**
1. Pick the target repository for autonomous PRs/branches (NOT a repo whose
   history you care about — e.g. a scratch org repo).
2. Create a fine-grained PAT scoped to that repo: `Contents: write`,
   `Pull requests: write`, `Issues: write`. Or run `gh auth login` — the server
   reads `HIVE_GITHUB_TOKEN` from the env; set `HIVE_GITHUB_USE_GH_CLI=1` to opt into the
   `gh auth token` fallback (off by default).
3. For Slack: create an *incoming webhook* bound to the target channel
   (simplest, no scopes to review) or a bot token with `chat:write`.
4. Set and restart (see `.env.example`):
   `HIVE_GATEWAY_TOKEN=<random>` · `HIVE_GITHUB_REPO=owner/name` · `HIVE_GITHUB_TOKEN=…`
   and/or `HIVE_SLACK_WEBHOOK_URL=…`.
5. Smoke check: `GET /api/integrations/status` should report
   `github.mode=live`, `slack.mode=live`; Live Hive page shows `github:live` /
   `slack:live` pills; boot log prints the `[hive-integrations]` line.

**Acceptance criteria:**
- [ ] `agent_solve` drill (or `hive task claim 801` … `hive verify`) opens a REAL
      PR on the target repo and the outbox row is `confirmed` with a
      `via=github-api` receipt.
- [ ] Re-running with the same outbox key produces NO second PR (idempotency).
- [ ] Slack post from `hive` CLI `post-slack` lands exactly once, carrying the
      `[hive:<key>]` marker.
- [ ] `INFRASTRUCTURE.md` §2 residual note is updated to "verified against real API".

---

## 2 — `pg`-backed runtime store for cloud parity

**Why:** the kernel persists via `node:sqlite` today — single-process,
single-writer, local disk. The design's Principle 8 ("same semantics local and
cloud") wants Postgres 16 + FORCE RLS as the production store, not just as a
verified schema. The migration and its verifier (`npm run verify:postgres`,
28/28 checks) are the acceptance gate that already exists.

**Blocked by:** engineering decision (connection strategy for serverless vs
long-lived gateway) and a managed Postgres instance.

**Steps:**
1. Define the store contract seam: `HiveStore` (today: `src/kernel/db.ts`)
   exposes sync `db`, `assertTenant()`, `getMeta()/rotateIncarnation()/
   exportBackupTempFile()/restoreFromBackupTempFile()`, WAL pragmas, SQLite FTS5.
2. Implement `PgHiveStore` against `pg` (dev-dep already installed):
   - per-request/per-transaction `SET LOCAL app.tenant_id = '<tenant>'` so the
     RLS policies from `001_postgres_rls.sql` enforce isolation in the database
     itself (defense in depth on top of `assertTenant`);
   - `authority_meta` singleton read at boot; `rotateIncarnation()` → `UPDATE …
     RETURNING incarnation`;
   - FTS: `fts_doc @@ to_tsquery('english', …)` + GIN index instead of FTS5;
   - PITR: WAL archiving / basebackup export in place of `VACUUM INTO` snapshots
     (document restore procedure; verify rotation kills stale `hct_` capability tokens);
   - transactions: keep the same savepoint semantics used by `store.tx()`.
3. Keep `node:sqlite` as the default for local dev/tests; select backend via
   env (`HIVE_STORE=sqlite|postgres`, `HIVE_PG_URL=…`) — do NOT delete the
   SQLite path (tests depend on it).
4. Parity verification: run the full chaos + integration suites against the pg
   backend (`HIVE_STORE=postgres npm test` + `npm run verify:postgres`); add a
   CI job doing exactly that against the `postgres:16-alpine` service.
5. Hash-chain/checkpoint reads stay identical (Ed25519 + canonicalJson are
   store-agnostic).

**Acceptance criteria:**
- [ ] All 17 specs pass with `HIVE_STORE=postgres`.
- [ ] `npm run verify:postgres` still 28/28 (incl. artifact).
- [ ] A pre-restore token is rejected after a PITR restore on pg (mirror of
      `authority.pitr.spec.ts`).
- [ ] One chaos drill (`gate.sha`) executed against the pg backend with logs.
- [ ] `INFRASTRUCTURE.md` §1/§6 updated (residuals removed) and README "cloud
      parity" section flipped from "SQLite" to "SQLite default, Postgres optional".

---

## 3 — Browser-level UI QA (Playwright)

**Why:** `npm run build` is green and every UI-called endpoint was curl-verified,
but nobody has rendered `Live Hive` in a browser. Rendering, interaction and
console errors are unverified.

**Blocked by:** browser binary downloads are outside this sandbox's egress
allowlist — but GitHub Actions runners can download them, so CI is the natural
place (or your workstation: `npx playwright install`).

**Status (2026-11-27):** `@playwright/test` added; `e2e/live-hive.spec.ts` +
`.github/workflows/ci.yml` job `ui-e2e` landed (asserts single-origin SPA headers,
401-without-session, admin-minted sign-in renders the board with zero page errors).
NOT executed in the dev sandbox (browser CDN off-egress) — needs one green CI run.
Remaining for full parity with the old item: drill click-through assertion and
tenant-switch/RLS assertion in e2e.

**Steps (remaining):**
1. Watch the first `ui-e2e` run on the Phase-2 PR; fix selectors if needed.
2. Extend `e2e/live-hive.spec.ts`: run a drill via the terminal → event appears in
   the signed-chain tab; tenant switch shows disjoint workspace (globex empty).

**Acceptance criteria:**
- [ ] CI green with `ui-e2e` job; artifacts (screenshots) uploaded on failure.
- [ ] No console errors on the Live Hive tab boot path.
- [ ] Drill click-through assertion passes (UI state change == kernel state
      change via `/api/state` comparison).
- [ ] `INFRASTRUCTURE.md` §3 flipped to verified.

---

## 4 — Deployment activation (single-origin gateway)

**Why (updated):** Phase 2 (decision §2.3) retired the split "Vercel static UI +
hosted gateway" topology. The supported shape is ONE origin: the Node gateway
serves `dist/` + `/api/*` on the same port (`npm run serve`). `vercel.json` remains
in the repo but reflects the OLD split topology and must not be deployed as-is.

**Blocked by:** gateway host decision (VM / Fly.io / Railway — NOT Vercel
serverless unless item #2 lands first: SQLite is not serverless-safe); your
explicit go-ahead (deploy posture; never auto-deployed).

**Steps:**
1. Host the gateway as one process: node gateway + volume for `.hive/` (or
   item #2's pg store), behind TLS; health check `/api/health`.
2. Env: `HIVE_ADMIN_TOKEN` (≥32 chars) · `HIVE_MASTER_KEY` · `HIVE_ALLOWED_HOSTS` ·
   optional `HIVE_GATEWAY_TOKEN` edge · `HIVE_CLOCK_MODE=wall` (default).
3. Webhooks LAST (only once public): `HIVE_GITHUB_WEBHOOK_SECRET` /
   `HIVE_SLACK_SIGNING_SECRET`; point repo/workspace webhooks at
   `/api/webhooks/github` / `/api/webhooks/slack`.
4. If you still want a Vercel-hosted frontend elsewhere, set
   `VITE_HIVE_API_BASE` at build time (origin only; there is no token variant — see .env.example) — but prefer the
   single-origin gateway (this repo's tested path).

**Acceptance criteria:**
- [ ] Deployed URL loads Live Hive served by the gateway, talks to same-origin `/api/state`.
- [ ] `/api/integrations/status` shows expected modes; bearer/session auth in force.
- [ ] Read-only smoke (`/api/health`, `/api/state`, one non-destructive drill) passes.
- [ ] Rollback procedure documented (redeploy previous gateway image/tag).

---

## Explicitly out of scope until these land

TLS/WAF in front of the gateway, secrets-manager integration, alerting export of
`call_telemetry`, queue worker for exactly-once Slack delivery, Postgres runtime
store (item #2 owns this). (GitHub/Slack webhook receivers WITH HMAC verification
landed 2026-11-26 — HIVE_GITHUB_WEBHOOK_SECRET / HIVE_SLACK_SIGNING_SECRET. Phase 2
(single-origin serve, SSE, presence, artifacts, SDK, outbox worker) landed 2026-11-27.)
