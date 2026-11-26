# ADR 0002 — VerifiedClose: non-author evidence + SHA-bound merge gate

**Status:** accepted · **Context:** preventing unverified self-merges

## Problem
An agent that writes code must not be able to merge it unreviewed. Review and
verification must be bound to the exact artifact that shipped.

## Decision
- Submission moves a task `claimed → submitted → verifying` and wakes a
  **non-author** verifier (author may never verify own work — enforced in
  `verifyTask`).
- Evidence rows (clean-sandbox verification receipts) are content-bound to
  `head_sha`; approvals are SHA-bound and invalidated on new pushes.
- Merge (`completeMergeAndVerifiedClose`) requires the gate to be satisfied
  (`gate_policy`) **and** computes `VerifiedClose` — a Merkle-style hash over
  `{taskId, headSha, evidenceHashes, approvalSigs, leaseEpoch}` — written by a
  final CAS (`merged → closed`) that is impossible without them.
- `verified_close` is the receipt that unblocks dependent tasks.

Reference: `submitTask` / `verifyTask` / merge path in `src/kernel/authority.ts`;
drill: `scripts/drill-stuck-verifier.mjs`; chaos specs in `tests/`.

## Consequences
- "Green CI" is necessary but not sufficient; the kernel requires a non-author
  verification receipt bound to the SHA.
- Workers self-landing green PRs (Cookout ADR 0127) is a **rejected** pattern —
  see ADR 0006.
