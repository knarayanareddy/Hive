# ADR 0006 — Rejected patterns

**Status:** rejected (by this project) · **Context:** patterns observed in
peer/workbench reviews that undermine the guarantees above

## Cookout ADR 0042 — "session tokens replace the lease"
**Rejected.** Fencing that depends on a bearer token's *existence* instead of a
`lease_epoch` CAS lets a zombie holding a valid-looking token overwrite merged
work. Tokens are authentication (who), not authorization over time (whether
*this claimant, this epoch* may act). Hive keeps both: sessions `hst_`/`hct_`
plus epoch CAS on every write. See ADR 0001.

## Cookout ADR 0061 — "deactivated owner's agents stay active"
**Rejected.** If an owner is disabled, their agents keeping capability is a
privilege-escalation hole. Cascade revocation is mandatory: attestation status
`deactivated`/`revoked` is checked at authorize time and is enforced for all
attestations the owner issued. (Enforced in `authorizePrincipal` /
`setAgentAttestationStatus` paths; exercised by custody & chaos specs.)

## Cookout ADR 0030 — "time budgets warn, never block"
**Rejected.** A budget that only warns is an accounting report, not a
protective control. Hive budget caps (`budget_cap_cents`) are enforced: the
kernel halts the task (`halted`) at the cap; it does not merely warn.

## Cookout ADR 0127 — "worker self-lands green PRs"
**Rejected.** A green CI run is not an independent verification, and the author
must never satisfy their own merge gate. Hive requires a non-author verifier's
receipt bound to the SHA and a satisfied gate before VerifiedClose (ADR 0002).
Workers pushing to `main` directly (or with self-approvals) violate the
coordination contract and are rejected on review.
