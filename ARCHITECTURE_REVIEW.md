# End-to-End Review: `Board × Buzz → Hive` Design & Prototype Artifact

## 1. Executive Summary

The reviewed Google Drive archive (`everyone-is-raving-about-vercel-board-from-vercel-and-buzz-from-jack-dorsey-...zip`) is a React 19 + Vite + Tailwind v4 interactive specification and prototype explorer titled **“Vercel Board × Buzz → Hive: compare, prototype, architect.”**

It synthesizes two complementary agent-collaboration launches plus LoopX operational lessons:
1. **Vercel Board** — headless coordination primitive (channels/threads, claim/lease/renew/complete, task dependencies, sleeping-agent watchers/schedules, path grants with `explain`, schema-validated payloads, two-way Slack/GitHub/Linear sync).
2. **Buzz (Block)** — self-hostable Nostr-inspired event workspace (keypair identities for humans and agents, scoped Owner Attestations, NIP-34 branch-as-room git forge, YAML workflows, unified FTS search, hash-chained tamper-evident audit log).
3. **Hive (Combined v2)** — a transactional **Authority Kernel** founded on **Projection ≠ Authority**: chat streams, cards, and Slack threads are read projections, while all state transitions happen via CAS-guarded typed commands with fencing epochs, independent clean-sandbox verification (`VerifiedClose`), capability tokens, outbound DLP, SHA-bound human gates, budget circuit breakers, and an idempotent outbox.

---

## 2. What the Design Gets Right

- **Sharp separation of Projection vs. Authority**: Treating chat prose (`"Fixed ✅"`) as non-authoritative eliminates premature closes and ambiguous natural-language state transitions.
- **Claim ≠ Lease**: Separating ownership assignment (`owner`) from write fencing (`lease_epoch` + `revision` CAS) and delegating renewal to scheduler/lifecycle hooks rather than LLM prompt memory directly solves stale/zombie agent clobbers.
- **Authorship ≠ Authority**: Combining Buzz's cryptographic Owner Attestations (`owner != agent`, scoped ops, expiry, revocation) with Board's hierarchical path grants (`explain`) and task-bound gateway `CapabilityToken`s prevents credential sprawl inside sandboxes.
- **Zero-Idle-Token Execution Model**: `wake_queue` + `read_cursor` working-set diffs avoid resident `--wait` loops and full-transcript context bloat.
- **Chaos-Driven Acceptance Criteria**: Mapping the 6 interactive fault toggles directly to 10 concrete chaos test specs (`fence.zombie`, `verify.falseclose`, `ingest.injection`, `outbox.replay`, `budget.breaker`, `gate.sha`, `log.tamper`, `authority.pitr`, `rls.isolation`, `wake.redeliver`) establishes measurable engineering exit criteria.

---

## 3. Architectural, Security & Code Findings (and How We Fixed Them in This Build)

| # | Severity | Area | Finding in Drive Artifact | Resolution Built in `/home/user/Hive` |
|---|---|---|---|---|
| **F1** | **Critical (TOCTOU)** | Verification ↔ Approval Gate (`Guide.tsx` Alg. 2 & 3) | `onPush` invalidates `approval` rows when a new commit lands, **but leaves the task in `awaiting_approval` without invalidating prior verification!** An agent could pass clean-sandbox verification on benign SHA `A`, push unverified SHA `B`, obtain human `/approve` on `B`, and merge unverified code. | `HiveKernel.pushPatch()` (`src/kernel/authority.ts`) both invalidates prior approvals **and** resets `awaiting_approval` → `verifying` whenever `head_sha` changes, while `isMergeAllowed()` requires a passing non-author `evidence` receipt matching the **exact** current `head_sha`. |
| **F2** | **High (Fencing Bypass)** | Lease Epoch on Outbox Effects (`Guide.tsx` Alg. 6) | `diagramData.ts` states *"Epoch must be checked server-side on every write, including outbox effects"*, yet Alg. 6 `runEffect(key, effect, args)` accepts bare keys without `guarded(tx, tok, taskId)` — allowing a zombie worker to open duplicate PRs or post to Slack. | `HiveKernel.runEffect()` enforces `guardedTask(tenant, token, taskId, 'effect:' + effect)` prior to outbox execution and records `lease_epoch` on every `outbox` row (`tests/fence.zombie.spec.ts`). |
| **F3** | **High (Audit Loss on Rollback)** | Fencing Telemetry vs. DB Transactions | Emitting `fence.rejected` inside the same rolled-back write transaction causes SQLite/Postgres `ROLLBACK` to erase the audit record of the zombie's rejected write attempt. | `guardedTask()` executes and persists `fence.rejected` to the signed hash-chained log *prior* to opening the mutation transaction, while retaining atomic `WHERE revision = ? AND lease_epoch = ?` CAS checks inside the transaction. |
| **F4** | **High (Incomplete Lifecycle)** | Schema & State Machine Gaps (`Guide.tsx` SQL & Alg. 2) | The `task` DDL in `Guide.tsx` omits `head_sha`, `verified_close`, `protected_path`, `gate_policy`, `branch_room`, and `labels`, even though `close()` and `approve()` read them. Additionally, Alg. 2 sets `state = 'merged'` when `!gate` without executing the outbox merge or advancing `merged → closed` (`VerifiedClose`). | Added all missing columns in `db/migrations/001_sqlite.sql` and `001_postgres_rls.sql`, and wired `completeMergeAndVerifiedClose()` to run the idempotent outbox merge (`merged`), compute `VerifiedClose` (`closed`), mint a Merkle checkpoint, and unblock dependent tasks. |
| **F5** | **Medium-High (PITR Safety)** | Missing DB Incarnation (`Guide.tsx` Phase 6 / Test 8) | Test 8 (`authority.pitr.spec`) requires PITR restores to invalidate pre-restore revision & capability tokens via DB incarnation rotation, but neither `authority_meta(incarnation)` nor token `incarnation` claims exist in the spec's SQL/types. | Added `authority_meta(incarnation, gateway_pub, ...)` + `rotateIncarnation()` + `exportBackupTempFile()` / `restoreFromBackupTempFile()`, and embedded signed `incarnation` claims in all `hct_*` capability tokens and `hrv_*` revision tokens (`tests/authority.pitr.spec.ts`). |
| **F6** | **Medium-High (Cryptography & Canonicalization)** | Hash Chain & Signatures (`util.ts`, `Guide.tsx`) | Prototypes used 53-bit non-cryptographic `cyrb53` hashes, lacked `checkpoint` DDL/Merkle roots, and used `JSON.stringify` (key-order nondeterministic across runtimes/JSONB) when hashing event payloads. | Implemented RFC-8785 deterministic `canonicalJson()`, real `node:crypto` **Ed25519** keypairs/signatures, **SHA-256** event chaining, and signed **Merkle root** checkpoints (`src/kernel/crypto.ts`, `tests/log.tamper.spec.ts`). |
| **F7** | **Medium (Multi-Tenancy Parity)** | Local SQLite vs. Postgres RLS (`Guide.tsx` Principle 8) | `Guide.tsx` notes SQLite drops RLS, risking violation of Principle 8 (*"Same semantics local and cloud"*) and `rls.isolation.spec`. | Enforced fail-closed `store.assertTenant()` default-deny guards + mandatory `tenant_id` scoping across every SQLite query (`tests/rls.isolation.spec.ts`), alongside full `FORCE ROW LEVEL SECURITY` DDL in `db/migrations/001_postgres_rls.sql`. |
| **F8** | **Medium (Dependency Semantics)** | Premature Unblocking (`boardEngine.ts`) | In Board's prototype, dependent tasks unblock as soon as an agent says `complete`. | In `HiveKernel.unblockDependents()`, `blocked` tasks transition to `ready` **only** when every upstream dependency reaches `state === 'closed'` with a cryptographic `verified_close` receipt (`tests/wake.redeliver.spec.ts`). |
| **F9** | **Low (Frontend / Prototype Bugs)** | `vite.config.ts` & `buzzEngine.ts` | `vite.config.ts` bundled everything via `vite-plugin-singlefile` without `0.0.0.0` host / proxy support; `buzzEngine.ts` `search()` ignored 2-char terms (`"ci"`, `"pr"`). | Updated `vite.config.ts` for `0.0.0.0` + `allowedHosts: true` + `/api` proxy, and fixed `buzzEngine.ts` tokenization (`>= 2` chars) while adding real SQLite FTS5 search to Hive. |

---

## 4. End-to-End Implementation Map

| Spec Layer (`Guide.tsx`) | Implemented Module(s) | Verification |
|---|---|---|
| **Authority Kernel (12-state CAS)** | `src/kernel/authority.ts`, `src/kernel/db.ts` | `fence.zombie.spec.ts`, `verify.falseclose.spec.ts` |
| **Ed25519 Keys, Attestations, Tokens & Merkle Log** | `src/kernel/crypto.ts`, `src/kernel/policy.ts` | `log.tamper.spec.ts`, `authority.pitr.spec.ts` |
| **Ingest Trust Labels & Outbound DLP** | `src/kernel/ingest.ts`, `src/kernel/policy.ts` | `ingest.injection.spec.ts` |
| **Independent Verifier & SHA-Bound Gates** | `src/kernel/authority.ts` | `verify.falseclose.spec.ts`, `gate.sha.spec.ts` |
| **Fenced Idempotent Outbox** | `src/kernel/outbox.ts`, `src/kernel/authority.ts` | `outbox.replay.spec.ts`, `fence.zombie.spec.ts` |
| **Budget Meter & Loop Circuit Breaker** | `src/kernel/authority.ts`, `src/kernel/commands.ts` | `budget.breaker.spec.ts` |
| **Wake Queue, Cursors & Working-Set Diff** | `src/kernel/authority.ts` | `wake.redeliver.spec.ts` |
| **SQLite WAL + Postgres 16 Forced RLS** | `db/migrations/001_sqlite.sql`, `db/migrations/001_postgres_rls.sql` | `rls.isolation.spec.ts` |
| **CLI, Registered `/commands` & HTTP Gateway** | `src/cli/parser.ts`, `src/cli/hive.ts`, `src/server/index.ts` | `./bin/hive.mjs`, `/api/*` |
| **Live Web Mission Control + Design Explorer** | `src/web/LiveHivePage.tsx`, `src/App.tsx` | `npm run build` + live preview |
