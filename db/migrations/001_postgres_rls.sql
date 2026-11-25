-- Hive Authority Kernel · Postgres 16 Multi-Tenant Hardened Schema
-- Enforces default-deny Row-Level Security (RLS) + DB incarnation PITR safety

CREATE TABLE IF NOT EXISTS authority_meta (
  singleton     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  incarnation   UUID NOT NULL DEFAULT gen_random_uuid(),
  gateway_pub   TEXT NOT NULL,
  rotated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principal (
  id               TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  pubkey           TEXT NOT NULL,
  owner            TEXT,
  harness          TEXT,
  role             TEXT NOT NULL DEFAULT 'member',
  attest_scope     JSONB,
  attest_not_after TIMESTAMPTZ,
  attest_revoked   BOOLEAN NOT NULL DEFAULT FALSE,
  attest_sig       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (kind = 'human' OR (owner IS NOT NULL AND owner <> id))
);

CREATE TABLE IF NOT EXISTS grant_rule (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  principal   TEXT NOT NULL,
  path        TEXT NOT NULL,
  can         TEXT[] NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS task (
  id                  TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  goal_id             TEXT,
  channel             TEXT NOT NULL,
  branch_room         TEXT,
  title               TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN (
    'blocked','ready','claimed','halted','expired','submitted','verifying',
    'rejected','awaiting_approval','reopened','merged','closed'
  )),
  owner               TEXT,
  lease_epoch         BIGINT NOT NULL DEFAULT 0,
  lease_until         TIMESTAMPTZ,
  attempt             INT NOT NULL DEFAULT 0,
  budget_cap_cents    INT NOT NULL DEFAULT 500,
  budget_spent        INT NOT NULL DEFAULT 0,
  revision            BIGINT NOT NULL DEFAULT 1,
  origin_operation_id TEXT NOT NULL,
  trust               TEXT NOT NULL DEFAULT 'external' CHECK (trust IN ('owner','member','external')),
  head_sha            TEXT,
  protected_path      TEXT,
  gate_policy         TEXT NOT NULL DEFAULT 'none' CHECK (gate_policy IN ('none','one','two_of_three')),
  verified_close      TEXT,
  labels              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS task_dep (
  tenant_id TEXT NOT NULL,
  task_id   TEXT NOT NULL,
  dep_id    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, dep_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES task(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, dep_id)  REFERENCES task(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event (
  seq          BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL UNIQUE,
  prev         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  channel      TEXT,
  task_id      TEXT,
  payload      JSONB NOT NULL,
  trust        TEXT NOT NULL CHECK (trust IN ('owner','member','external')),
  attest       JSONB NOT NULL DEFAULT '[]'::jsonb,
  sig          TEXT NOT NULL,
  fts_doc      TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(kind,'') || ' ' || coalesce(actor,'') || ' ' || coalesce(channel,'') || ' ' || coalesce(payload::text,''))
  ) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_fts ON event USING GIN (fts_doc);

CREATE TABLE IF NOT EXISTS checkpoint (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  upto_seq      BIGINT NOT NULL,
  head_event_id TEXT NOT NULL,
  merkle_root   TEXT NOT NULL,
  incarnation   UUID NOT NULL,
  sig           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  head_sha     TEXT NOT NULL,
  lease_epoch  BIGINT NOT NULL,
  result       JSONB NOT NULL,
  passed       BOOLEAN NOT NULL,
  produced_by  TEXT NOT NULL,
  sandbox_tree TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES task(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS approval (
  id                 TEXT NOT NULL,
  tenant_id          TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  head_sha           TEXT NOT NULL,
  approver           TEXT NOT NULL,
  role               TEXT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  comment            TEXT,
  sig                TEXT NOT NULL,
  invalidated_at     TIMESTAMPTZ,
  invalidated_reason TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES task(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  task_id         TEXT,
  lease_epoch     BIGINT,
  effect          TEXT NOT NULL,
  args            JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','confirmed','failed')),
  receipt         JSONB,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS wake_queue (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  principal         TEXT NOT NULL,
  task_id           TEXT,
  channel           TEXT,
  reason            TEXT NOT NULL,
  no_sync           BOOLEAN NOT NULL DEFAULT FALSE,
  due_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  delivery_attempts INT NOT NULL DEFAULT 0,
  ack_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS read_cursor (
  tenant_id   TEXT NOT NULL,
  principal   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  last_seq    BIGINT NOT NULL DEFAULT 0,
  incarnation UUID NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal, scope)
);

CREATE TABLE IF NOT EXISTS call_telemetry (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  principal   TEXT NOT NULL,
  lease_epoch BIGINT NOT NULL,
  cost_cents  INT NOT NULL,
  call_sig    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-tenant Row-Level Security (default-deny when app.tenant_id is unset)
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'principal','grant_rule','task','task_dep','event','checkpoint',
    'evidence','approval','outbox','wake_queue','read_cursor','call_telemetry'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) AND current_setting(''app.tenant_id'', true) <> '''') WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) AND current_setting(''app.tenant_id'', true) <> '''');',
      tbl
    );
  END LOOP;
END $$;
