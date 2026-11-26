# ADR 0005 — External effects: outbox commit-then-send with one claim fence

**Status:** accepted · **Context:** email/PR/Slack side effects must not fire
on rolled-back transactions or duplicate after a crash

## Problem
Calling a provider inside a DB transaction can emit an effect that the database
then forgets; crashing between the provider call and the confirm write causes
duplicates; a failed send must not be silently lost or infinitely retried.

## Decision
- **Commit-then-send:** effects are staged inside the transaction as
  `outbox(status='pending')` rows; `tx()` flushes commit hooks **after** the
  outermost commit, so a rolled-back tx stages nothing and sends nothing.
- **One claim fence:** inline drain (CLI fast path) and the async worker both
  send only rows they claim atomically
  (`UPDATE ... SET status='sent', locked_by, locked_until WHERE ... locked_until <= now`) —
  on Postgres this maps to `FOR UPDATE SKIP LOCKED`.
- **Retry discipline:** retryable failures re-drain with `min(2^attempts, 60s)`;
  DLP-blocked or `attempts >= HIVE_OUTBOX_MAX_ATTEMPTS` (default 8) rows are
  terminal and never re-claimed; the poison sweep marks exhausted rows `failed`.
- **Provider reality:** GitHub effects carry idempotency keys with
  provider-side read-after-write reconciliation (no duplicate PRs). Slack has
  no provider-side idempotency: the legacy EffectLedger + `[hive:<key>]` marker
  is **kept** until a real queue/worker replaces it (Phase 3+).

Reference: `src/kernel/db.ts` (commit hooks), `src/kernel/authority.ts`
(`processOutboxPending`, `reconcileOutbox`), `src/integrations/`.

## Consequences
- Crash any point of the effect path ⇒ at most one provider call per claim
  window; retries are bounded; nothing is lost silently.
- Exactly-once Slack delivery remains best-effort + detectable duplicates;
  stated openly rather than simulated.
