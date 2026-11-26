# ADR 0001 — Authority Kernel CAS fencing via `lease_epoch`

**Status:** accepted · **Context:** multi-agent task claiming on a shared store

## Problem
Multiple agents act on the same task. A crashed or zombie worker holds a stale
lease and wakes up later; a naive system lets it overwrite newer work.

## Decision
Every task mutation is fenced by an optimistic CAS on `(revision, lease_epoch)`:

- Claims mint a lease-scoped `hct_` capability token binding `{sub, taskId,
  lease_epoch, incarnation}`.
- Workers heartbeat; `schedulerTick` sweeps `claimed` tasks whose `lease_until`
  passed, transitions `claimed → expired → ready`, and **keeps** `lease_epoch`
  so the next claim bumps it (`N → N+1`) — stale tokens then fail the epoch check.
- All terminal/CAS writes carry `WHERE ... AND revision = ? AND lease_epoch = ?`;
  zero rows changed ⇒ `ConflictError`.

Reference: `src/kernel/authority.ts` (claimTask, submitTask, guard writes),
`schedulerTick` (expired sweep, §"Atomic lease fencing"), `src/kernel/crypto.ts`
(`hct_` issue/verify).

## Consequences
- A zombie can never silently clobber newer work — at worst it gets a 409.
- Fencing correctness is independent of process wall time: epochs are
  logical, leases are time-bounded.
- Rejecting session-token-style fencing (Cookout ADR 0042, "tokens replace the
  lease") is mandatory — see ADR 0006.
