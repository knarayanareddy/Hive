# Architecture Decision Records

Every ADR below is **accepted and in force** in this repository unless marked
*rejected*. Rejected records (ADR 0006) document patterns that were evaluated and
deliberately excluded — they exist so the exclusion is a decision, not an accident.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](./0001-authority-kernel-cas-fencing.md) | Authority Kernel CAS fencing via `lease_epoch` | accepted |
| [0002](./0002-verified-close-non-author.md) | VerifiedClose: non-author evidence + SHA-bound gate | accepted |
| [0003](./0003-single-machine-vs-postgres-rls.md) | Single-machine SQLite topology; PG FORCE RLS as the parity gate | accepted |
| [0004](./0004-webhook-hmac-inbound.md) | Inbound webhooks: HMAC before parse, replay window, persisted dedup | accepted |
| [0005](./0005-outbox-commit-then-send.md) | External effects: outbox commit-then-send with one claim fence | accepted |
| [0006](./0006-rejected-patterns.md) | Rejected patterns (Cookout ADR 0042/0061/0030/0127) | rejected |

See also [`../GLOSSARY.md`](../GLOSSARY.md) for the terms used here, and
[`../../SECURITY_REMEDIATION_PLAN.md`](../../SECURITY_REMEDIATION_PLAN.md) for the
remediation history that motivated these records.
