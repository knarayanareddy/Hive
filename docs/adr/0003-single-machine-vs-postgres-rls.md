# ADR 0003 — Single-machine SQLite topology; PG FORCE RLS as the parity gate

**Status:** accepted · **Context:** deployment shape and tenant isolation

## Problem
The design demands the same kernel semantics locally and hosted, without
distributed-systems false promises.

## Decision
- **Now (Phases 2–3):** single process, SQLite in WAL mode, single writer.
  Tenant isolation is enforced in-kernel (`assertTenant`); every query carries
  `tenant_id`. The supported topology is one machine + one volume — not
  serverless, not multi-node. Presence/SSE are process-local (documented).
- **Parity gate:** `db/migrations/001_postgres_rls.sql` applies FORCE RLS +
  default-deny policies to all 17 tenant tables, and
  `scripts/verify-postgres-rls.mjs` proves them against real PG16 as a
  non-superuser role (30/30 checks in CI). The runtime `pg` store remains
  future work (TODO #2); the DDL is the contract it must satisfy.
- M1 (PG schema parity: `schema_def`/`channel_room`, `*_json` JSONB naming,
  `sim_now_ms`, 12→7 enum collapse) landed 2026-11-26 as its dedicated migration
  PR, deliberately separate from security/phase PRs.

## Consequences
- No "scale out" claims until the PG store lands and SSE/presence move to a bus.
- A hosted deployment is honest: one machine, one `/data` volume, health check
  on `/api/health` (see `Dockerfile`, `fly.toml`, `render.yaml`).
