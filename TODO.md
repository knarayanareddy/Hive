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
| 3 | Browser-level UI QA (Playwright) | OPEN | Browser download outside sandbox allowlist; fine on CI |
| 4 | Vercel deployment of the static UI + hosted gateway | OPEN | Gateway host decision + Vercel project/env setup |

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
27/27 checks) are the acceptance gate that already exists.

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
- [ ] `npm run verify:postgres` still 27/27 (unchanged schema semantics).
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

**Steps:**
1. `npm i -D @playwright/test` + `npx playwright install --with-deps chromium`.
2. `playwright.config.ts`: start `npm run dev` (or a dedicated preview URL),
   baseURL `http://localhost:5173`.
3. Specs (`e2e/live-hive.spec.ts`) to prove the UI talks to the REAL kernel:
   - page loads without console errors; Live Hive tab renders task list;
   - `/api/integrations/status` pills render (github/slack modes visible);
   - click a fault drill (e.g. `drill_zombie`) → lease_epoch banner updates,
     event appears in the signed-chain tab;
   - run `/approve 801 --sha 3fa9c1` via the CLI terminal → status flips toward
     merged/closed; VerifiedClose badge appears;
   - tenant switch acme→globex shows an empty/disjoint workspace (RLS);
   - screenshot the board on failure for review.
4. Add a `ui-e2e` job to `.github/workflows/ci.yml` (runs on PR, chromium only).

**Acceptance criteria:**
- [ ] CI green with `ui-e2e` job; artifacts (screenshots) uploaded on failure.
- [ ] No console errors on the Live Hive tab boot path.
- [ ] Drill click-through assertion passes (UI state change == kernel state
      change via `/api/state` comparison).
- [ ] `INFRASTRUCTURE.md` §3 flipped to verified.

---

## 4 — Vercel deployment of the static UI + hosted gateway

**Why:** `vercel.json` is ready (Vite preset, `dist` output, SPA rewrites), but
no deployment exists and the deployed UI cannot work without a publicly reachable
`/api`. Vercel cannot run the Node gateway + SQLite as-is; it needs item #2's
pg backend or a long-lived host for the gateway.

**Blocked by:** gateway host decision; Vercel project creation/env vars need
your go-ahead (this repo deliberately did not auto-deploy).

**Steps:**
1. Host the gateway (choose one):
   - **Fly.io / Railway / VM**: node gateway + `docker-compose.yml` Postgres 16
     (or managed pg), env `HIVE_GATEWAY_TOKEN=<random>`, `HIVE_DB_PATH` or
     `HIVE_STORE=postgres` (item #2), behind TLS; health check `/api/health`.
   - Vercel serverless is possible ONLY after item #2 (pg store) — SQLite on
     serverless is ephemeral and single-tenant breaks.
2. Vercel project (github.com/knarayanareddy/Hive, framework Vite):
   env `VITE_HIVE_API_BASE=https://<gateway-host>` · `VITE_HIVE_API_TOKEN=<same as HIVE_GATEWAY_TOKEN>`.
3. `vercel` connector usage (needs explicit go-ahead): `create_project` →
   `create_env_var` × 2 → `create_deployment` with `git_source` ref
   `arena/446b8aab-hive` (or `main` once merged).
4. Wire inbound webhooks LAST (only once the gateway is public): set
   `HIVE_GITHUB_WEBHOOK_SECRET` / `HIVE_SLACK_SIGNING_SECRET` on the gateway and point
   the repo/workspace webhook at `/api/webhooks/github` / `/api/webhooks/slack`
   (HMAC verification + replay window + delivery dedup implemented 2026-11-26).
   Outbound effects (item #1) don't need webhooks.
5. Verify: open the deployed URL → pills show `live`; state loads; a drill runs;
   CORS: gateway must allow the Vercel origin (or same-origin proxy).

**Acceptance criteria:**
- [ ] Deployed URL loads Live Hive and shows real kernel state from the gateway.
- [ ] `/api/integrations/status` from the UI = expected modes; bearer auth in force.
- [ ] A read-only smoke (`/api/health`, `/api/state`, one drill) passes from the
      deployed origin.
- [ ] Rollback procedure documented (redeploy previous Vercel deployment; gateway
      reimage from git tag).

---

## Explicitly out of scope until these land

TLS/WAF in front of the gateway, secrets-manager integration, alerting export of
`call_telemetry`, queue worker for exactly-once Slack delivery, Postgres runtime
store (item #2 owns this). (GitHub/Slack webhook receivers WITH HMAC verification
landed 2026-11-26 — HIVE_GITHUB_WEBHOOK_SECRET / HIVE_SLACK_SIGNING_SECRET.)
