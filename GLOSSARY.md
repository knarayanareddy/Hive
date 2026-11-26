# Hive Glossary

Terms used across the codebase, specs, and runbooks. Security/operations
context: Hive is a fenced, verified agent-coordination plane — treat every
entry here as load-bearing vocabulary.

**Authority Kernel** — the transactional core (`src/kernel/authority.ts`).
All mutations flow through it; all guarantees are enforced inside it.

**CAS (compare-and-swap) fencing** — every contended write is conditional
(`WHERE revision = ? AND lease_epoch = ?`); zero affected rows ⇒ `ConflictError`.
See ADR 0001.

**lease_epoch** — the logical fencing counter on a task. Claims mint a fresh
epoch; expiry keeps it so the next claim increments. Stale-epoch writes are
rejected regardless of wall-clock time.

**lease** — a time-bounded claim on a task (`lease_until`). Heartbeats renew
it; `schedulerTick` expires missed ones and re-queues the task.

**hct_ — capability token** — Ed25519-signed, lease-scoped proof
`{sub, taskId, lease_epoch, incarnation, …}` presented by agents for
privileged kernel ops. Verified in `src/kernel/crypto.ts`.

**hst_ — session token** — per-principal HTTP session issued by
`/api/session/mint` (admin-gated). Bound to `{tenant, principal}`; sent as
`Authorization: Bearer hst_…`. The UI stores it in `sessionStorage`.

**VerifiedClose** — the terminal receipt `vc_<hash>` written on the
`merged → closed` CAS. Hashed over `{taskId, headSha, evidenceHashes,
approvalSigs, leaseEpoch}`; unblocks dependent tasks. See ADR 0002.

**verified close / verified-close gate** — the SHA-bound merge precondition:
gate satisfied (`none`/`one`/`two_of_three` approvals, un-invalidated, SHA-matched)
plus non-author evidence bound to the same SHA.

**clean-sandbox verification** — running the verifier's repro outside the
author's workspace; produces the evidence row that binds `head_sha`.

**evidence** — kernel record `(ev_*)` written by verification (receipt hash,
`passed`, `headSha`). Required for VerifiedClose.

**outbox** — `outbox` table holding staged side effects
(`pending → sent → confirmed | failed`). Drained inline (CLI) or by the async
worker; one atomic claim fence guards both. See ADR 0005.

**commit hook / commit-then-send** — `tx()` outermost commit flushes
post-commit hooks (SSE fan-out, outbox kickoff). Rolled-back transactions emit
nothing and send nothing.

**claim fence** — the mutex of the effect system: `UPDATE … SET status='sent',
locked_by, locked_until WHERE … locked_until <= now`. At most one process
performs the provider call per claim window.

**incarnation** — the store's identity (`authority_meta.incarnation`), rotated
on PITR restore/bootstrap. Tokens minted before a restore are rejected
(incarnation claim mismatch).

**wake / wake_queue / lost-wake redelivery** — directed notification for an
agent (e.g. `verify:<sha>`). Delivered by `schedulerTick`; unacked wakes are
re-delivered each tick (`delivery_attempts` grows) with compressed
working-set diffs (`readInboxSinceCursor`).

**working-set diff** — the delta a woken agent needs (events since their
read cursor, compressed); not a full resync.

**EffectLedger** — append-only JSONL (`.hive/live-ledger.jsonl`) recording
performed provider effects. Retained for Slack (no provider-side idempotency);
see ADR 0005.

**DLP (data-loss-prevention) scan** — secret-shaped content detector applied
to outbound effects **and artifact bytes**; hits are refused, never sent/saved.

**incarnation-scoped incarnation / Merkle-chained event log** — the signed,
hash-chained log (`event` table). Each event carries `seq`, `prev`, `sig`;
Domain-separated Merkle checkpointing binds log + tenant.

**FORCE RLS / default-deny** — Postgres Row-Level Security applied to owners
too (`FORCE`), with `tenant_id = current_setting('app.tenant_id')` policies
plus an explicit empty-string deny. Verified 28/28 by `verify:postgres`.

**SSE / watch_replaced** — `GET /api/events` streams committed events to
watchers (20/principal; agents: 1 live stream — a new one closes the old with
a `watch_replaced` frame). UI uses it for the live badge + debounced refetch.

**read_cursor** — per-principal, per-scope high-water mark into the event
log; advances idempotently on ack.

**CAS conflict / ConflictError** — zero-row compare-and-swap result; surfaced
as HTTP 409.

**tenant pin / tenant switch** — sessions pin a tenant end-to-end; the UI
disables the tenant selector while signed in. Row isolation is DB-enforced.

**drill** — an executable, destructive-ish proof against a real kernel
(`scripts/backup-drill.mjs`, `drill-stuck-verifier.mjs`, smoke-load, chaos
matrix). Drills mutate throwaway workspaces and assert the failure mode is
*contained*, not absent.

**PR-sequence protocol** — phases land by sequence on the working branch;
each phase ships by PR with CI green; outward deploys require explicit
user confirmation.
