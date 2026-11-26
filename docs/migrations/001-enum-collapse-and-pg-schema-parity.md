# Migration 001 — PG schema parity + 12→7 task-state enum collapse

**Dedicated migration PR** (decision §2.4 — never folded into security/phase PRs).
Pre-production software: **dev DBs are re-seeded fresh; there is no production data to migrate.**

## What changed

### A. PG schema parity (`db/migrations/001_postgres_rls.sql`, in place — pre-production)

| Change | Detail |
|---|---|
| + `schema_def` table | structured-output schema registry; tenant-scoped; FORCE RLS |
| + `channel_room` table | branch-as-room registry; tenant-scoped; FORCE RLS |
| `authority_meta` + `sim_now_ms BIGINT NOT NULL DEFAULT 0` | simulation clock mirror (SQLite parity; the kernel pins `now()` in tests) |
| `authority_meta` + `gateway_priv TEXT` | custodial gateway key, AES-256-GCM (`enc:v1:*`), **nullable**: written post-keygen by the future pg runtime; never a placeholder. App role has SELECT only — protect it like `gateway_pub` |
| `principal` + `privkey TEXT` | custodial principal key, encrypted at rest; **nullable** pre-custody |
| JSON column renames | PG names now match the kernel's: `payload→payload_json`, `attest→attest_json`, `result→result_json`, `args→args_json`, `receipt→receipt_json`, `labels→labels_json`, `can→can_json` (all `JSONB NOT NULL`, keys kept distinct from content) |
| `grant_rule.can TEXT[] → can_json JSONB` | the kernel stores a JSON array of strings; `TEXT[]` was lossy/wrong shape |
| `event.fts_doc` | generated tsvector now includes `coalesce(task_id,'')` (was: kind/actor/channel/payload only) |
| indexes | + `idx_event_tenant_seq`, `idx_event_tenant_ch`, `idx_event_tenant_task`, `idx_principal_session_principal` |
| RLS | `schema_def`, `channel_room` added to the FORCE-RLS loop (17 tables) |

Deliberately **out of scope**: TIMESTAMPTZ↔ms-epoch and UUID↔TEXT semantic drift.
The PG schema stays PG-native (route B); a future pg-store adapts at the boundary.
Re-verify after this file changes: `npm run verify:postgres` (applies from scratch; 30/30).

### B. 12→7 task-state enum collapse

The 5 removed states were **transactional waypoints**: in all four write paths
they were written and rewritten inside a single transaction, so they never
persisted an observable row:

| Removed | Collapsed into | Where |
|---|---|---|
| `expired` | `ready` (atomic claimed→ready, `lease_epoch` kept) | `schedulerTick` sweep |
| `submitted` | `verifying` (single CAS in `submitTask`) | `submitTask` |
| `rejected` | `ready` (verify-fail re-queue in one UPDATE) | `verifyTask` fail path |
| `reopened` | `ready` (gate-reject re-queue in one UPDATE) | `decideGate` reject path |
| `merged` | `closed` (single atomic merge→close CAS in `finalizeVerifiedClose`, guarded by `state IN ('awaiting_approval','verifying') AND revision = fresh`) | merge path |

**The 7 observable states:** `blocked, ready, claimed, halted, verifying, awaiting_approval, closed`
(unchanged CHECK targets in both DDLs; `types.ts` `TaskState`; UI badge tones; Guide SQL;
the `lifeDiagram` in DiagramsPage).

### Apply / re-seed (dev, pre-production)

- SQLite dev DBs: delete `.hive/live.db*` and restart — the kernel seeds a fresh
  workspace with the new CHECK (this repo's demo DB was re-seeded with this change).
- PG: `scripts/verify-postgres-rls.mjs` drops/recreates its throwaway DB on every
  run — no action. If you created a PG dev DB with the old file, drop and recreate it.

### Rollback

1. `git revert` this migration commit.
2. Restore the pre-migration SQLite file from its backup, or re-seed (always valid).
3. PG: recreate from the reverted migration, re-run `verify:postgres`.
   (No data exists in either store yet — rollback is a code operation, not a data operation.)

## Verification

`npm test` 32/32 · `npm run verify:postgres` **30/30** (incl. `schema_def`/`channel_room`
FORCE flags + default-deny) · `drill:backup` ALL PASS · `drill:stuck-verifier` 13/13 ·
build green · live single-origin smoke re-verified on a fresh re-seeded workspace.
