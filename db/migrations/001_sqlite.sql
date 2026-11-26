-- Hive Authority Kernel · SQLite (WAL + FTS5) Local-First Schema
-- Mirrors Postgres 16 RemoteAuthority semantics with tenant_id + DB incarnation (PITR safety)

CREATE TABLE IF NOT EXISTS authority_meta (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  incarnation     TEXT NOT NULL,
  gateway_pub     TEXT NOT NULL,
  gateway_priv    TEXT NOT NULL,
  sim_now_ms      INTEGER NOT NULL,
  rotated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS principal (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  pubkey          TEXT NOT NULL,
  privkey         TEXT NOT NULL,
  owner           TEXT,
  harness         TEXT,
  role            TEXT NOT NULL DEFAULT 'member',
  attest_scope    TEXT,
  attest_not_after INTEGER,
  attest_revoked  INTEGER NOT NULL DEFAULT 0,
  attest_sig      TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (kind = 'human' OR (owner IS NOT NULL AND owner <> id))
);

CREATE TABLE IF NOT EXISTS grant_rule (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  principal       TEXT NOT NULL,
  path            TEXT NOT NULL,
  can_json        TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS schema_def (
  name            TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  description     TEXT NOT NULL,
  required_json   TEXT NOT NULL,
  enums_json      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS channel_room (
  name            TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('channel', 'branch')),
  repo            TEXT,
  branch          TEXT,
  origin          TEXT NOT NULL DEFAULT 'hive',
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS task (
  id                  TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  goal_id             TEXT,
  channel             TEXT NOT NULL,
  branch_room         TEXT,
  title               TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN (
    'blocked','ready','claimed','halted','verifying',
    'awaiting_approval','closed'
  )),
  owner               TEXT,
  lease_epoch         INTEGER NOT NULL DEFAULT 0,
  lease_until         INTEGER,
  attempt             INTEGER NOT NULL DEFAULT 0,
  budget_cap_cents    INTEGER NOT NULL DEFAULT 500,
  budget_spent        INTEGER NOT NULL DEFAULT 0,
  revision            INTEGER NOT NULL DEFAULT 1,
  origin_operation_id TEXT NOT NULL,
  trust               TEXT NOT NULL DEFAULT 'external' CHECK (trust IN ('owner','member','external')),
  head_sha            TEXT,
  protected_path      TEXT,
  gate_policy         TEXT NOT NULL DEFAULT 'none' CHECK (gate_policy IN ('none','one','two_of_three')),
  verified_close      TEXT,
  labels_json         TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS task_dep (
  tenant_id       TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  dep_id          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, dep_id)
);

CREATE TABLE IF NOT EXISTS event (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL,
  id              TEXT NOT NULL UNIQUE,
  prev            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  actor           TEXT NOT NULL,
  channel         TEXT,
  task_id         TEXT,
  payload_json    TEXT NOT NULL,
  trust           TEXT NOT NULL CHECK (trust IN ('owner','member','external')),
  attest_json     TEXT NOT NULL DEFAULT '[]',
  sig             TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_tenant_seq ON event (tenant_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_tenant_ch ON event (tenant_id, channel, seq);
CREATE INDEX IF NOT EXISTS idx_event_tenant_task ON event (tenant_id, task_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  event_id UNINDEXED,
  tenant_id UNINDEXED,
  kind,
  actor,
  channel,
  content
);

CREATE TABLE IF NOT EXISTS checkpoint (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  upto_seq        INTEGER NOT NULL,
  head_event_id   TEXT NOT NULL,
  merkle_root     TEXT NOT NULL,
  incarnation     TEXT NOT NULL,
  sig             TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  lease_epoch     INTEGER NOT NULL,
  result_json     TEXT NOT NULL,
  passed          INTEGER NOT NULL,
  produced_by     TEXT NOT NULL,
  sandbox_tree    TEXT NOT NULL,
  receipt_hash    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS approval (
  id                  TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  head_sha            TEXT NOT NULL,
  approver            TEXT NOT NULL,
  role                TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  comment             TEXT,
  sig                 TEXT NOT NULL,
  invalidated_at      INTEGER,
  invalidated_reason  TEXT,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  task_id         TEXT,
  lease_epoch     INTEGER,
  effect          TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','confirmed','failed')),
  receipt_json    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  locked_by       TEXT,
  locked_until    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS artifact (
  tenant_id   TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  evidence_id TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, sha256)
);

CREATE TABLE IF NOT EXISTS wake_queue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL,
  principal         TEXT NOT NULL,
  task_id           TEXT,
  channel           TEXT,
  reason            TEXT NOT NULL,
  no_sync           INTEGER NOT NULL DEFAULT 0,
  due_at            INTEGER NOT NULL,
  delivered_at      INTEGER,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ack_at            INTEGER
);

CREATE TABLE IF NOT EXISTS read_cursor (
  tenant_id       TEXT NOT NULL,
  principal       TEXT NOT NULL,
  scope           TEXT NOT NULL,
  last_seq        INTEGER NOT NULL DEFAULT 0,
  incarnation     TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal, scope)
);

CREATE TABLE IF NOT EXISTS call_telemetry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  principal       TEXT NOT NULL,
  lease_epoch     INTEGER NOT NULL,
  cost_cents      INTEGER NOT NULL,
  call_sig        TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

-- Principal sessions (per-principal HTTP identity; replaces shared bearer for actions)
CREATE TABLE IF NOT EXISTS principal_session (
  token_hash    TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_principal_session_principal ON principal_session(tenant_id, principal_id);

-- Inbound webhook replay deduplication
CREATE TABLE IF NOT EXISTS webhook_delivery (
  delivery_id   TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  source        TEXT NOT NULL,
  received_at   INTEGER NOT NULL
);
