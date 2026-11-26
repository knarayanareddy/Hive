# Hive — Security Remediation Plan (union of two independent reviews)

_Status: committed 2026-11-26. PR #2 (TODO.md) merged as `1424c64`; remediation work lands on
`arena/446b8aab-hive` as the next PR. This document is the execution contract for that PR._

## 1. Provenance

Two independent principal-engineer/security reviews of `knarayanareddy/Hive` (base `dd0265b`, PR #2
already merged) were delivered as self-contained Next.js "workbench" apps:

- **Review A** — `hive-security-review-request.zip` (Drive). Verdict **NO-GO**. 15 findings
  (3 Critical / 6 High / 4 Medium / 2 Low), 21 aspect reviews, 16-row cookout ADOPT/ADAPT/SKIP table,
  13-step roadmap (phases 0–4), two-week ship plan.
- **Review B** — `engineering hivereview.zip` (Drive). Verdict **NO-GO**. 17 findings
  (5 Critical / 7 High / 4 Medium / 1 Low), 21 aspect reviews (same aspect numbering),
  11-row cookout table (adds SKIPs for ADR 0030 and ADR 0127), 12-step roadmap (phases 0–4),
  single highest-leverage change **identical to A's**.

Both zips are review *artifacts*. Neither is a product. They are not wired into the build; keep them
quarantined (§8).

Every load-bearing claim below was re-verified against this repository before acceptance
(`file:line` citations are current as of commit on branch `arena/446b8aab-hive`).

## 2. Decision record (2026-11-26)

1. **PR strategy** — PR #2 merged first (docs-only). Remediation (this plan) lands on
   `arena/446b8aab-hive` as the next PR (#3 by sequence).
2. **This plan** — committed as `SECURITY_REMEDIATION_PLAN.md`.
3. **Topology** — single-origin: the Node gateway serves the Vite build (Review B). Eliminates the
   cross-origin CORS bug class and `VITE_HIVE_API_TOKEN` browser-exposure. Applies from Phase 2.
4. **12→7 state-enum collapse** — deferred out of Phase 0/1 into its **own dedicated migration PR**
   (reviewable, reversible, does not block security work). All other fixes proceed independently.
5. **Phase ordering** — Review A's Phase-0 placement of the async outbox worker stands. Review B's
   deferral of it to Phase 2 is rejected (it would undercut the shared highest-leverage change).
6. **Enum collapse acceptance criteria** — when its dedicated PR lands, existing dev DBs are
   re-seeded fresh (pre-production), with a written migration note and rollback instructions.

## 3. Definition of done (per phase and overall)

- `npm test` green — all specs (12 chaos/integration + session/authz/webhooks/custody) pass (updated only where they exercised the
  vulnerable tokenless path) **plus** new specs listed in each phase.
- `npm run verify:postgres` — 28/28 RLS checks (incl. principal_session + webhook_delivery + artifact).
- `npm run drill:backup` — all PASS (now including stale-WAL restore drill).
- Bearer-token matrix re-verified on a live local gateway for `/api/state`, `/api/cli`, `/api/reset`.
- INFRASTRUCTURE.md states only what is true of the shipped tree.
- Live GitHub/Slack drill executed against a scratch repo with explicit user go-ahead (out of scope
  for code PRs; tracked in TODO.md).

## 4. Findings union (confirmed)

Severity uses B's split where A and B disagreed (F-10 re-rated Critical). "A" = Review A only,
"B" = Review B only, "Both" = both reviews.

### Critical
| ID | Finding | Source |
|---|---|---|
| C1 | HTTP boundary trusts `body.actor`/`body.tenant`; shared static `HIVE_GATEWAY_TOKEN` is all-or-nothing, non-constant-time compare | A CRIT-01a / B F-01 / Both |
| C2 | `/api/state` exposes `activeTokens` — live `hct_` capability token strings — plus tenant snapshot to any caller | B F-01 |
| C3 | `pushPatch` / `postChannelMessage` / `runEffect` skip `guardedTask` when `token` omitted (zombie/self-approve bypass) | A CRIT-01 / B F-02 / Both |
| C4 | `verifyTask` takes **no** capability token; humans bypass scope/role in `verifyPrincipalAuthority` → any human (incl. `dana`, role `member`) can fabricate verifier receipts and approve `security/` two-of-three gates | B F-10 |
| C5 | `POST /api/reset` unconditionally `fs.rmSync`s the DB; `drill_tamper` corrupts live audit rows | A CRIT-03 / B F-05 / Both |
| C6 | Plaintext Ed25519 custodial keys (`principal.privkey`, `authority_meta.gateway_priv`) in SQLite; `/tmp/hive-pitr-snap-*.db` world-readable | A CRIT-02 / B F-04 / Both |

### High
| ID | Finding | Source |
|---|---|---|
| H1 | Live GitHub merge always throws (`completeMergeAndVerifiedClose` omits `prNumber`); no `sha:` binding; `repo: "acme/www"` hardcoded (cross-tenant merge target) | A HIGH-01 / B F-03 / Both (+ my `acme/www` catch) |
| H2 | `execFileSync('curl')` inside `BEGIN IMMEDIATE`; outbox `status='failed'` row erased by ROLLBACK; 10–30s event-loop freeze | A HIGH-04 / B F-07 / Both |
| H3 | `isMergeAllowed` / `shipTask` ignore `task.state`; `decideGate('reject')` never invalidates prior approvals | A HIGH-05 / B F-09(1) / Both |
| H4 | EffectLedger (`.hive/live-ledger.jsonl`) has no `tenantId` → cross-tenant receipt leak + effect suppression (`task:801/...` collides in acme/globex) | A HIGH-06 / B F-06 / Both |
| H5 | `verifyTask` human path and `decideGate` ignore `requireChannelAccess`/`role`; `setAgentAttestationStatus` callable by anyone | B F-10 (see C4) |
| H6 | `LiveHivePage.tsx` crashes on 401/500 (`res.ok` unchecked) contradicting INFRASTRUCTURE.md; CORS omits `Authorization` while `*` | A HIGH-03 / B F-11 / Both |
| H7 | No Host validation (421), unbounded `readBody`, no rate limits, `/api/ingest` unauthenticated with caller-controlled `protectedPath` | A HIGH-02 / B F-12 / Both |
| H8 | `claimTask` mints hardcoded `ops` without intersecting agent attestation scope | B F-09(2) (A: acceptance criterion of P0.1) |
| H9 | PITR `restoreFromBackupTempFile` leaves stale `-wal`/`-shm`; `backup-drill.mjs` calls `verifyLog` without `'latest'` | B F-14 |

### Medium
| ID | Finding | Source |
|---|---|---|
| M1 | `001_postgres_rls.sql` missing `schema_def`/`channel_room`; `authority_meta` lacks `sim_now_ms`; ~9–11 column/type divergences; `event.fts_doc` omits `task_id`; PG kernel-incompatible | A MED-01 / B F-08 / Both |
| M2 | `/api/state` O(N) full hash-chain verify + N+1 principal queries + N+1 OpenSSL calls per poll (~168ms p95 @ c=32) | A MED-02 / B F-15(4) / Both |
| M3 | `computeEventId` raw `|` preimage, omits `attest_json`; Merkle odd-leaf duplication without domain separation; `verifyLog` passes when tail/checkpoints deleted; canonicalJson injection | A MED-03 / B F-15 / Both |
| M4 | DLP gaps: no central call; patterns miss `github_pat_`, `xox[baprs]-`, `ASIA`, `sk-ant-`, `sk-proj-`; secrets logged unredacted at ingest | A MED-04 / B F-13 / Both |
| M5 | Frozen sim clock (`simNowMs` @ `1795606800000`) — leases/attestations never expire wall-clock; cross-tenant time jumps | A MED-04 / B F-16 / Both |
| M6 | The 6× loop breaker counts per `lease_epoch` (resets on re-claim); `task.attempt` uncapped | B F-09(3) |

### Low
| ID | Finding | Source |
|---|---|---|
| L1 | `.gitignore:9` (`.env.*`) blocks `.env.example` — never committed despite INFRASTRUCTURE.md claims; `githubFromEnv` silently harvests `gh auth token`; `HIVE_EFFECT_HTTP_TIMEOUT_MS` documented but unwired | A LOW-01/02 / B F-17 / Both |
| L2 | Dead `hrv_` revision tokens (`issueRevisionToken`/`checkRevisionToken` have no callers); ledger has no rotation/fsync/bounds; CLI string injection via chat | B L/A L / Both |

### Independently caught during triage (neither review)
| ID | Finding |
|---|---|
| X1 | `createTask` allocates IDs as `String(801 + COUNT(*))` — IDs depend on row count; collisions across tenants and after deletes (root cause of dual-801 acme/globex) |
| X2 | Both review workbenches are unauthenticated read/write admin UIs (Review A's PATCH flipped HIVE-CRIT-01 status over plain curl — demonstrated; Review B ships `resetStatuses` POST). Not Hive gateway issues; guide disposition in §8 |
| X3 | Hardcoded `acme/www` also appears outside the merge path (`ensureChannelRoom`); kernel is repo-coupled to the acme seed |

## 5. Phase 0 — Trust boundaries (acceptance bar before any network exposure)

**0.1 Per-principal sessions; kill shared identity.** `principal_session` table (sqlite+pg),
`hst_<base64url(32B)>` issued via admin-bootstrap, SHA-256-hashed at rest, TTL (default 12h),
`revoked` flag. `HIVE_ADMIN_TOKEN` (≥32 chars, required when `NODE_ENV=production` or
`HIVE_REQUIRE_ADMIN=1`) gates session minting and `/api/reset`. HTTP routes derive
`(tenant, actor)` **exclusively** from `hst_…`/`hct_…`; `body.actor` accepted only when
`HIVE_DEV_INSECURE_ACTOR=1` (loud warning at boot; never in prod). Delete `tokenJarsByTenant`
and the `activeTokens` leak. `crypto.timingSafeEqual` on token hashes.
→ closes C1, C2. New spec: `tests/auth.session.spec.ts`.

**0.2 Unconditional kernel fencing + human scope/role enforcement.** `guardedTask` required for any
agent task mutation (`pushPatch`, `postChannelMessage` task-scoped, `runEffect` task-bound); missing
token for agent → 403. `runEffect` with neither token nor actor → 403. `verifyTask` requires a
human (or agent) whose effective scope covers `task.verify` — for humans require
`role IN ('owner','lead','security','verifier')`; `member` rejected. `decideGate` enforces
`requireChannelAccess(channel, 'post')` and, for `security/` `two_of_three` gates,
`role IN ('owner','lead','security')`. `verifyPrincipalAuthority` no longer short-circuits humans
before scope checks (humans keep root-of-authority for *unscoped* ops but scoped ops require role).
`setAgentAttestationStatus` restricted to owning human or `role='owner'`. `claimTask` intersects
minted `hct_` `ops` with attestation scope. `isMergeAllowed`/`shipTask` require
`task.state IN ('awaiting_approval')` or `(task.state='verifying' AND gate='none')`; closed/halted
tasks can never re-merge. `decideGate('reject')` invalidates `approve` rows for the `headSha`.
`task.attempt` capped (`MAX_ATTEMPTS`, default 5 → `halted`); loop breaker counts across epochs.
→ closes C3, C4, H3, H5, H8, M6. Update `gate.sha.spec.ts`, `ingest.injection.spec.ts` and any spec
exercising the tokenless path; add `tests/authz.human.spec.ts` (member cannot task.verify / cannot
approve `security/` gate / cannot revoke others' agents; owner can).

**0.3 Live GitHub merge + DLP centralization.** `completeMergeAndVerifiedClose` resolves `prNumber`
from the confirmed `open-pr` outbox receipt (`SELECT receipt_json … WHERE tenant_id=? AND effect='open-pr'
AND task_id=? AND status='confirmed'`) with gateway-side branch-head fallback; `PUT …/pulls/:n/merge`
passes `sha: headSha`; `findExisting('merge')` resolves via open PR head lookup. Outbound repo slug
sourced from `HIVE_GITHUB_REPO` (kernel reads env with fallback constant — documented interim until
`task.repo` column lands with the enum-collapse migration). `executeOutboxInternal` hard-blocks on
`enforceOutboundDlp(canonicalJson(args))`; `ingestInbound` redacts secret spans before persisting;
`SECRET_PATTERNS` extended (`github_pat_`, `xox[baprs]-`, `ASIA`, `sk-ant-`, `sk-proj-`).
→ closes H1, M4. Extend `tests/integrations.spec.ts` (merge passes `prNumber`+`sha`),
`tests/ingest.injection.spec.ts`.

**0.4 Outbox durability (commit-then-send) + drill gating.** Split `executeOutboxInternal` into:
`stageOutboxEffect` (inside `store.tx()`: evidence/approval reads, `outbox status='pending'` insert,
idempotent key) and `drainOutboxEffect` (outside the tx: findExisting→perform→`confirmed`/`failed`+
receipt event). `completeMergeAndVerifiedClose` performs tx1 (evidence → outbox pending →
`state='merged'` → `task.merged` event) then drains, then tx2 (`merged→closed`, verified-close receipt,
checkpoint). A crashed drain leaves a `pending`/`sent` row; `kernel.reconcileOutbox(tenantId)` runs at
server boot to retry/close. `/api/reset` and `/api/scenario` return 403 unless `HIVE_ENABLE_DEV_DRILLS=1`;
`/api/reset` additionally requires the admin token. `restoreFromBackupTempFile` removes `-wal`/`-shm`
before copy and runs `INSERT INTO event_fts(event_fts) VALUES('integrity-check')`; `backup-drill.mjs`
passes `'latest'` to `verifyLog` and gains a stale-WAL restore case. EffectLedger gains required
`tenantId` and is folded into the outbox decision (kept, but tenant-scoped, until Phase 2 deletion).
→ closes C5, H2, H4, H9.

**0.5 Inbound webhook HMAC + request caps.** New `src/server/webhooks.ts`: `POST /api/webhooks/github`
(`X-Hub-Signature-256`) and `POST /api/webhooks/slack` (`X-Slack-Signature`, `v0:timestamp:body`),
raw-body HMAC-SHA256 verified with `timingSafeEqual` **before parse**, timestamp replay window
(300s), `delivery_id` dedup via `webhook_delivery` table (sqlite+pg). `readBody` enforces 1 MiB → 413.
Foreign `Host` → 421 (exempt `GET /api/health`); `Allow-Origin` restricted to `HIVE_ALLOWED_ORIGINS`
(default loopback) with `Authorization` in `Allow-Headers`.
→ closes H7. New `tests/webhooks.hmac.spec.ts`.

**0.6 Key custody.** `authority_meta.gateway_priv` → `HIVE_GATEWAY_SIGNING_KEY` env (base64url PKCS8);
DB keeps only `gateway_pub` (+ `key_id` for rotation). Human `principal.privkey` no longer read from DB
for signing approvals: approvals/attestation preimages are signed client-side when the key is present,
or the deployment envelope-encrypts custodial keys under `HIVE_MASTER_KEY` (AES-256-GCM) when running
in managed mode. `exportBackupTempFile` writes into a `0700` dir with `0600` mode.
→ closes C6.

**0.7 Docs truth pass** (ship with 0.1–0.6). `INFRASTRUCTURE.md` corrected: 401 behavior (honest until
Phase 3 lands), `.env.example` committed with `!.env.example` in `.gitignore`, merge-path notes, PG
coverage caveat. `TODO.md` gh-CLI line → opt-in (`HIVE_GITHUB_USE_GH_CLI=1`). `SECURITY_REMEDIATION_PLAN.md`
(this file) kept current. X2 cross-ref: workbenches quarantined (§8).
→ closes L1 (part), keeps docs honest.

**Explicitly deferred:** PG runtime parity (0.7-parity / M1) — lands as Phase 0.5 or first item of
Phase 1 after the above, since it doubles the review surface; `schema_def`+`channel_room`+type alignment
+12 specs on PG16 + 28/28 RLS (as of Phase 2's artifact addition). Enum collapse — dedicated PR (§2.4).

## 6. Phase 1 — Perimeter, performance, correctness
Foreign `Host` 421 + 1 MiB cap (from 0.5), per-identity token buckets (6000 req/min, 60 effect calls/min,
429 + `retryAfterSeconds`; in-memory ADR 0033), incremental `verifyLog` cache (`(incarnation,
lastVerifiedSeq, lastEventId)` + `PRAGMA data_version` invalidation + KeyObject memoization — target
`/api/state` p95 < 25ms; cache invalidation drill added to `smoke-load.mjs`), domain-separated Merkle
(`0x00` leaf / `0x01` node), `canonicalJson` over `{domain:'hive.event.v1', …}` including `attest`,
`chk.uptoSeq` lower-bound check, wall-clock default (`HIVE_CLOCK_MODE=wall`) with per-tenant sim offsets
only in tests, `MAX_ATTEMPTS` halt, cross-epoch loop breaker, dead `hrv_` removal, DLP central call
verified by spec, `/api/state` drops `activeTokens` and (target) returns ETag/304.
→ M2, M3, M5, L2; hardens H6's server side.

## 7. Phases 2–4 (outline)
**Phase 2 — single-origin serve + streaming + SDK** (topology decision §2.3): Node gateway serves the
Vite build; gateway static hosting retires CORS class; SSE `/api/events` with `Last-Event-ID` → `event.seq`
(20 streams/principal; 1 live stream per agent, `watch_replaced` on reconnect); presence registry
(60s grace); evidence artifact store (disk or S3 via `aws4fetch`, sha256-addressed, `sandbox` CSP +
`nosniff`); typed `hive/sdk` with auto-heartbeat lease renewal; Playwright `ui-e2e` in CI;
async outbox worker (`FOR UPDATE SKIP LOCKED`) replacing the in-process drain.
**Phase 3 — deploy activation**: `Dockerfile`/`fly.toml`/`render.yaml` single-machine
(`min_machines_running=1`, `/data` volume, `/api/health` check); docker CI smoke; live scratch-repo
drill (PR open → SHA-bound merge → closed) with explicit user go-ahead; `INFRASTRUCTURE.md` final pass.
**Phase 4 — discipline**: `docs/adr/` (authority-kernel CAS fencing, verified-close non-author,
single-machine vs PG RLS, webhook HMAC, outbox commit-then-send), `GLOSSARY.md`, explicit rejections of
ADR 0042/0061/0030/0127 in writing, `drill-stuck-verifier.mjs`, `drill:backup` in CI.

## 8. Workbench disposition (X2)
Both Drive zips are **archived review artifacts**, not deliverables: no deploys, no authored PRs,
no reuse of their code. Any retained copy must be stored outside the repo (Drive) unchanged.
The first workbench's unauthenticated `PATCH /api/audit` demonstrated an anonymous write; treat both
as untrusted input. If the findings tracking is wanted later, re-implement a minimal authenticated
checklist inside the repo (Phase 4) — do not revive the zips.

## 9. Anti-goals / rejected patterns (write these into ADRs in Phase 4)
- Cookout ADR 0042 (session tokens replace lease) — **rejected**: destroys zombie fencing.
- ADR 0061 (deactivated owner's agents stay active) — **rejected**: cascade revocation is mandatory.
- ADR 0030 (time budgets warn, never block) — **rejected**: Hive budget cap halts.
- ADR 0127 (worker self-lands green PRs) — **rejected**: violates verified-close / SHA-bound gate.
- Enum collapse (12→7) — approved **only** as its dedicated PR (§2.4); not folded into security work.
- `HIVE_DEV_INSECURE_ACTOR` must never be set in shared/prod environments.

## 10. Risks & rollback
- **Session change breaks dev scripts** — `smoke-load.mjs`/`backup-drill.mjs` mint a session via admin
  bootstrap (`HIVE_ADMIN_TOKEN`) instead of anonymous calls; `HIVE_DEV_INSECURE_ACTOR=1` remains for
  one-off CLI ergonomics.
- **verifyTask role tightening breaks specs** — specs updated to use owner/lead/security actors;
  `gate.sha.spec.ts` exercises tokenless-agent path no more (it now expects 403).
- **Commit-then-send split** — crash between drain steps leaves `pending` row; boot reconcile
  (`reconcileOutbox`) retries; monitor `outbox.status='pending'` age metric (Phase 3).
- **DLP hard block in outbox** — false positive fails the *effect*, never the *audit trail*: the
  outbox row goes `failed` with DLP reason; approval/evidence tx already committed.
- **Docs pass** — any INFRASTRUCTURE.md sentence that is not true of the merged tree is a defect.

---

## Execution log (updated 2026-11-26)

- **Phase 0 code (this branch, PR #3 pending):** 0.1 per-principal sessions
  (`hst_`, SHA-256 at rest, TTL 12h/24h cap, `principal_session` table, admin-gated
  `/api/session/mint`, `/api/session/me|revoke`, 401 without session, UI sign-in +
  401 banner, `activeTokens` leak removed, per-session `hct_` jars) · 0.2 kernel
  fencing+human role gates (tokenless agents refused on pushPatch/runEffect/
  postChannelMessage; member cannot task.verify; two_of_three requires
  owner|lead|security; attestation revoke = owning human or owner; mint ∩
  attestation scope; reject invalidates approvals; isMergeAllowed state-fenced;
  MAX_ATTEMPTS=5 halt; cross-epoch loop breaker) · 0.3 merge path (prNumber from
  confirmed open-pr receipt, `sha=` on PUT merge, `HIVE_GITHUB_REPO`, DLP at
  drain, ingest redacts secret spans, patterns extended) · 0.4 commit-then-send
  outbox + `reconcileOutbox()` at boot (pending→drained, merged→closed) + drill
  gating (403 `/api/reset`, `/api/scenario`) + FTS integrity-check at restore +
  stale-WAL drill + EffectLedger tenantId · 0.5 webhook HMAC receivers + 1 MiB
  cap + 421 Host + loopback CORS · 0.6 `HIVE_MASTER_KEY` custodial envelope
  (legacy re-encryption sweep) + `HIVE_GATEWAY_SIGNING_KEY` override · 0.7 docs
  truth pass (INFRASTRUCTURE.md, .env.example, TODO.md).
- **New specs (16/16 green):** `auth.session.spec.ts`, `authz.human.spec.ts`,
  `webhooks.hmac.spec.ts`, `custody.spec.ts`; existing specs rewired off the
  tokenless path (`gate.sha.spec.ts` now exercises reject→re-claim→push).
- **PG RLS parity for the two new tables** landed in `001_postgres_rls.sql`
  (strict `app.tenant_id <> ''` predicate) + `verify-postgres-rls.mjs` covers both
  (28/28). Full `schema_def`/`channel_room`/`sim_now_ms` PG alignment (M1) remains
  Phase 0.5/1 as planned.
- **Pushed + PR #3 opened 2026-11-26** (https://github.com/knarayanareddy/Hive/pull/3) on explicit user go-ahead. Phase 0 closed.

### Execution log — Phase 1 (2026-11-27, this branch / PR #3)

- **verifyLog hot path (M2)** — incremental cache keyed on
  `(tenant, selector, resolved checkpoint id, mutationEpoch, incarnation, PRAGMA data_version)`;
  same-process mutations bump `mutationEpoch`; out-of-process writes caught by `data_version`
  (proven by `tests/kernel.verifylog_cache.spec.ts`, which tampers via a *second* connection);
  KeyObject + verdict memoization in `crypto.ts`; checkpoint lower-bound (`chk.uptoSeq > log end` →
  reject) + `headEventId` binding (M3); domain-separated Merkle (`0x00` leaf / `0x01` node).
  Measured: `/api/state` p50 ≈ 16ms, p95 ≈ 28–35ms under 16-way concurrency (was p50 ≈ 86ms,
  p95 ≈ 168ms). Plan target `<25ms p95` NOT yet met under load — residual item (snapshot
  serialization now dominates; consider pre-computed snapshot cache in Phase 2+).
- **Event content hash v1 (M3)** — `sha256(canonicalJson({domain:"hive.event.v1", …, attest}))`;
  pipe-join preimage ambiguity eliminated; `attest` chain now bound into the id. **Breaking
  change**: pre-Phase-1 databases fail `verifyLog` — re-seed/restore required (demo DB re-seeded
  2026-11-27). No migration: pre-production.
- **Per-identity token buckets (H7)** — 6000 req/min; 60 effect calls/min
  (CLI `effect run…`, `/api/scenario`, `/api/chaos-run`); 429 + `Retry-After` +
  `retryAfterSeconds`; loopback/Host/CORS unchanged; `/api/health` exempt; in-memory
  (resets on restart; single-process ADR-0033 stance).
- **Wall clock (M5)** — `HIVE_CLOCK_MODE=wall` default; `sim` frozen clock only under
  `tests/_setup.ts` (specs pin it). `hive tick --advance` keeps working in wall mode via a
  process-local virtual offset (resets on restart; fails safe — leases expire sooner).
- **`/api/state` ETag/304** — baseline hash excludes volatile `now`; `If-None-Match` → 304.
  `activeTokens` was already absent.
- **Dead `hrv_` revision tokens removed** — `issueRevisionToken`/`checkRevisionToken`/
  `RevisionToken` deleted; PITR spec rewired to capability-token incarnation rejection.
- **M6 loop breaker** — confirmed already landed in Phase 0 (`MAX_ATTEMPTS=5` halt, attempt
  counter survives re-claim/re-epoch). DLP centralization verified: outbox drain →
  `enforceOutboundDlp` pre-send, failures mark row `failed` (specs: `integrations.spec.ts`,
  `ingest.injection.spec.ts`).
- **New spec count: 17/17 green (at Phase 1).** PG RLS 28/28 · `drill:backup` ALL PASS · build green ·
  live chaos-run 10/10 (post-v1-hash) · demo DB re-seeded clean.
- **Verification cache drill** — kernel spec + opt-in `smoke-load.mjs` `HIVE_SMOKE_ALLOW_RESET=1`
  reset drill (passes: incarnation changes, post-reset snapshot verifies).
- **Executor note:** Phase 1 touches the SQLite open path on every request (`PRAGMA data_version`);
  if the PG runtime lands (Phase 3), replace with `pg_snapshot`/xmin-based invalidation.

### Execution log — Phase 2 (2026-11-27, PR follows)

- **Single-origin serve (decision §2.3)** — gateway serves `dist/` (SPA fallback, immutable
  `/assets/*`, `no-cache` index, strict CSP + `nosniff`, traversal guard); UI defaults to
  same-origin; `VITE_HIVE_API_*` reduced to escape hatch; CORS loopback allowlist kept for dev
  only. `npm run serve` = build + serve. Verified live.
- **SSE `GET /api/events`** — post-commit fan-out via a store-level commit hook (`tx()` outermost
  commit flushes; rollback emits nothing); `id: seq`, Last-Event-ID resume, 15s `: ping`,
  read-scoped per channel, 20 streams/principal, agents 1 live stream (`watch_replaced`),
  429 past cap. Debounced UI re-fetch on events (250ms) instead of UI surgery.
- **Presence registry** — 60s grace, heartbeat 15s, `presence` frames + `GET /api/presence`;
  in-memory/single-process (documented; not multi-node).
- **Artifact store** — disk, sha256 content-addressed, tenant-scoped index, 0600/0700, DLP scan
  pre-disk, `sandbox` CSP + `nosniff` on fetch, read-time hash re-verify; S3 deliberately not
  implemented (untested code rejected; seam `HIVE_ARTIFACT_DIR` documented).
- **SDK `hive/sdk`** — typed client (`getState/cli/me/presence/artifactPut/Get/events-generator`)
  + `withLeaseHeartbeat` (hct_ renew every ttl/3; rotation threaded through callback).
  Emitted to `dist-sdk/` via `npm run build:sdk`; `exports["./sdk"]`. AbortSignal-clean.
- **Async outbox worker** — `processOutboxPending` every 1s/tenant; ONE atomic claim fence for
  inline + worker drains (SKIP-LOCKED semantics; PG → `FOR UPDATE SKIP LOCKED`); retryable-failure
  backoff min(2^n, 60s); DLP/max-attempt rows terminal (8); boot `reconcileOutbox` retained.
  Inline drain kept as CLI fast path (determinism documented). **EffectLedger kept** — live Slack
  has no provider idempotency; deletion deferred to Phase 3 queue worker (deviation documented).
- **Specs 17 → 32** (`streams`, `outbox.worker`, `artifacts`, `sdk`); **Playwright ui-e2e in CI**
  (`ui-e2e` job) — **green on PR #4** (run 45827695160, 42s). It caught a real bug (fixed in 8b7cca2):
  fresh sign-in never re-pulled `/api/state`/integrations and the SSE effect didn't re-run on session
  flip, so the board stayed stuck on the connecting card until reload. Locators also made
  strict-mode-safe (166ec47). Dev sandbox still cannot download browsers; CI is the runner.
- **DoD status:** `npm test` 32/32 · verify:postgres **28/28** (verify script extended: `artifact`
  added to grants + FORCE-flag + default-deny checks) · drill:backup PASS · build green ·
  smoke-load static+ETag drills PASS · live chaos 10/10 re-verified · 17 → 32 specs.
- **Honesty ledger for Phase 2:** (1) ui-e2e coverage narrow (headers/401/sign-in/SSE); drill and
  tenant-RLS e2e assertions pending; (2) S3 artifact backend absent;
  (3) presence/SSE single-process; (4) `/api/state` p95 ~34ms (snapshot memoization not done);
  (5) EffectLedger not deleted (see above); (6) Playwright report uploaded only on CI failure.
