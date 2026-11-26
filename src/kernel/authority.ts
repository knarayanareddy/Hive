import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  attestationPreimage,
  canonicalJson,
  computeEventId,
  generateEd25519KeyPair,
  merkleRoot,
  mintCapabilityToken,
  sha256,
  signEd25519,
  verifyCapabilityToken,
  verifyEd25519,
} from "./crypto";
import { HiveStore } from "./db";
import { CUSTODY_PURPOSES, decryptCustodial, encryptCustodial, masterKeyFromEnv } from "./custody";
import { ingestInbound, type RawInboundInput } from "./ingest";
import { EffectConnectorHub } from "./outbox";
import {
  assertCapabilityAllows,
  enforceOutboundDlp,
  explainGrant,
  gatePolicyForTask,
  matchScopePattern,
  resolveGatePolicyForPath,
  verifyPrincipalAuthority,
} from "./policy";
import { parseSlashCommand } from "./commands";
import {
  type ApprovalRecord,
  ArtifactCorruptError,
  type CapabilityClaims,
  type ChannelRoom,
  type CheckpointRecord,
  ConflictError,
  type EffectKind,
  type EventRecord,
  type EvidenceRecord,
  FencedError,
  ForbiddenError,
  type GatePolicy,
  type GrantRecord,
  HaltedError,
  type InboundMessage,
  type LogVerifyResult,
  type OutboxRecord,
  type Principal,
  type SchemaRecord,
  type TaskRecord,
  type TaskState,
  type Trust,
  ValidationError,
  type WakeRecord,
  type WorkingSetDelivery,
} from "./types";

/** Maximum verify→reject→reclaim attempts before a task is halted by the breaker (across lease epochs). */
const MAX_ATTEMPTS = 5;
/** Outbox drain fence: how long a claim holds before another worker may re-claim (SKIP-LOCKED window). */
const OUTBOX_LOCK_MS = 30_000;

export class HiveKernel {
  public readonly store: HiveStore;
  public readonly connectors: EffectConnectorHub;
  /** Bumped on every event-store mutation (append/tamper) so cached log verifications invalidate safely. */
  private mutationEpoch = 0;
  private readonly logVerifyCache = new Map<string, LogVerifyResult>();
  private static readonly LOG_VERIFY_CACHE_LIMIT = 32;
  /** Post-commit event fan-out (SSE streams subscribe here). */
  private readonly eventListeners = new Set<(ev: EventRecord) => void>();
  private readonly instanceId = crypto.randomUUID();

  constructor(store?: HiveStore, connectors?: EffectConnectorHub) {
    this.store = store ?? new HiveStore(":memory:");
    this.connectors = connectors ?? new EffectConnectorHub();
  }

  /* ========================================================================
   *  META, CLOCK & INCARNATION (PITR SAFETY)
   * ====================================================================== */

  public now(): number {
    return this.store.now();
  }

  public getIncarnation(): string {
    return this.store.getMeta().incarnation;
  }
  /* ========================================================================
   *  PRINCIPALS & OWNER ATTESTATIONS (BUZZ IDENTITY MODEL)
   * ====================================================================== */

  public registerHuman(
    tenantId: string,
    params: { id: string; role?: string },
  ): Principal {
    const tId = this.store.assertTenant(tenantId);
    const kp = generateEd25519KeyPair();
    const now = this.now();
    const role = params.role ?? "member";
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO principal
         (id, tenant_id, kind, pubkey, privkey, owner, harness, role, attest_scope, attest_not_after, attest_revoked, attest_sig, created_at)
         VALUES (?, ?, 'human', ?, ?, NULL, NULL, ?, NULL, NULL, 0, NULL, ?)`,
      )
      .run(params.id, tId, kp.publicKey, this.custodialPrivate(kp.privateKey), role, now);
    return this.getPrincipal(tId, params.id)!;
  }

  public registerAgent(
    tenantId: string,
    params: {
      id: string;
      owner: string;
      harness: string;
      role?: string;
      scope: string[];
      ttlMs?: number;
    },
  ): Principal {
    const tId = this.store.assertTenant(tenantId);
    if (params.owner === params.id) {
      throw new ValidationError("agent cannot attest for itself (owner === id)");
    }
    const ownerRow = this.getPrincipalWithSecret(tId, params.owner);
    if (!ownerRow || ownerRow.kind !== "human") {
      throw new ForbiddenError(`owner ${params.owner} must be a registered human`);
    }
    const kp = generateEd25519KeyPair();
    const now = this.now();
    const notAfter = now + (params.ttlMs ?? 8 * 60 * 60 * 1000);
    const preimage = attestationPreimage({
      tenantId: tId,
      owner: params.owner,
      agentId: params.id,
      agentPub: kp.publicKey,
      scope: params.scope,
      notAfter,
    });
    const sig = signEd25519(ownerRow.privkey, preimage);

    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO principal
         (id, tenant_id, kind, pubkey, privkey, owner, harness, role, attest_scope, attest_not_after, attest_revoked, attest_sig, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        params.id,
        tId,
        kp.publicKey,
        this.custodialPrivate(kp.privateKey),
        params.owner,
        params.harness,
        params.role ?? "worker",
        JSON.stringify(params.scope),
        notAfter,
        sig,
        now,
      );
    return this.getPrincipal(tId, params.id)!;
  }

  public setAgentAttestationStatus(
    tenantId: string,
    actorId: string,
    agentId: string,
    op: "revoke" | "restore" | "expire",
  ): Principal {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const actor = this.requirePrincipal(tId, actorId);
      if (actor.kind !== "human") {
        throw new ForbiddenError("only humans can modify agent attestations");
      }
      const agent = this.getPrincipalWithSecret(tId, agentId);
      if (!agent || agent.kind !== "agent" || !agent.owner) {
        throw new ValidationError(`no such agent: ${agentId}`);
      }
      if (agent.owner !== actor.id && actor.role !== "owner") {
        throw new ForbiddenError(
          `only the owning human "${agent.owner}" or an "owner" may ${op} the attestation of "${agentId}"`,
        );
      }
      const ownerRow = this.getPrincipalWithSecret(tId, agent.owner)!;
      const now = this.now();
      if (op === "revoke") {
        this.store.db
          .prepare(
            "UPDATE principal SET attest_revoked = 1 WHERE tenant_id = ? AND id = ?",
          )
          .run(tId, agentId);
      } else if (op === "expire") {
        const scope = JSON.parse(agent.attest_scope ?? "[]") as string[];
        const sig = signEd25519(
          ownerRow.privkey,
          attestationPreimage({
            tenantId: tId,
            owner: agent.owner,
            agentId,
            agentPub: agent.pubkey,
            scope,
            notAfter: now,
          }),
        );
        this.store.db
          .prepare(
            "UPDATE principal SET attest_not_after = ?, attest_sig = ? WHERE tenant_id = ? AND id = ?",
          )
          .run(now, sig, tId, agentId);
      } else {
        const scope = JSON.parse(agent.attest_scope ?? "[]") as string[];
        const notAfter = now + 8 * 60 * 60 * 1000;
        const sig = signEd25519(
          ownerRow.privkey,
          attestationPreimage({
            tenantId: tId,
            owner: agent.owner,
            agentId,
            agentPub: agent.pubkey,
            scope,
            notAfter,
          }),
        );
        this.store.db
          .prepare(
            "UPDATE principal SET attest_revoked = 0, attest_not_after = ?, attest_sig = ? WHERE tenant_id = ? AND id = ?",
          )
          .run(notAfter, sig, tId, agentId);
      }
      this.appendEvent(tId, {
        kind: `attestation.${op}`,
        actor: actorId,
        channel: null,
        taskId: null,
        payload: { agentId, op },
      });
      return this.getPrincipal(tId, agentId)!;
    });
  }

  private custodialPrivate(plainB64: string): string {
    const masterKey = masterKeyFromEnv();
    return masterKey ? encryptCustodial(plainB64, masterKey, CUSTODY_PURPOSES.principal) : plainB64;
  }

  private getPrincipalWithSecret(tenantId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM principal WHERE tenant_id = ? AND id = ?")
      .get(tenantId, id) as
      | {
          id: string;
          tenant_id: string;
          kind: "human" | "agent";
          pubkey: string;
          privkey: string;
          owner: string | null;
          harness: string | null;
          role: string;
          attest_scope: string | null;
          attest_not_after: number | null;
          attest_revoked: number;
          attest_sig: string | null;
        }
      | undefined;
    if (row && row.privkey) {
      return {
        ...row,
        privkey: decryptCustodial(row.privkey, masterKeyFromEnv(), CUSTODY_PURPOSES.principal),
      };
    }
    return row;
  }

  public getPrincipal(tenantId: string, id: string): Principal | undefined {
    const tId = this.store.assertTenant(tenantId);
    const row = this.getPrincipalWithSecret(tId, id);
    if (!row) return undefined;
    return this.mapPrincipal(row);
  }

  public listPrincipals(tenantId: string): Principal[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM principal WHERE tenant_id = ? ORDER BY kind DESC, id ASC")
      .all(tId) as Parameters<typeof this.mapPrincipal>[0][];
    return rows.map((r) => this.mapPrincipal(r));
  }

  private mapPrincipal(row: {
    id: string;
    tenant_id: string;
    kind: "human" | "agent";
    pubkey: string;
    owner: string | null;
    harness: string | null;
    role: string;
    attest_scope: string | null;
    attest_not_after: number | null;
    attest_revoked: number;
    attest_sig: string | null;
  }): Principal {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      pubkey: row.pubkey,
      owner: row.owner ?? undefined,
      harness: row.harness ?? undefined,
      role: row.role,
      attestation:
        row.kind === "agent" && row.owner && row.attest_sig
          ? {
              owner: row.owner,
              scope: JSON.parse(row.attest_scope ?? "[]") as string[],
              notAfter: Number(row.attest_not_after ?? 0),
              revoked: Boolean(row.attest_revoked),
              sig: row.attest_sig,
            }
          : undefined,
    };
  }

  private requirePrincipal(tenantId: string, id: string): Principal {
    const p = this.getPrincipal(tenantId, id);
    if (!p) throw new ForbiddenError(`unknown principal "${id}" in tenant "${tenantId}"`);
    return p;
  }

  private authorizePrincipal(
    tenantId: string,
    principalId: string,
    requiredOp: string,
  ): { principal: Principal; attestChain: string[] } {
    const principal = this.requirePrincipal(tenantId, principalId);
    const owner = principal.owner
      ? this.getPrincipal(tenantId, principal.owner)
      : undefined;
    const { attestChain } = verifyPrincipalAuthority(
      principal,
      owner,
      requiredOp,
      this.now(),
    );
    return { principal, attestChain };
  }

  /* ========================================================================
   *  GRANTS, SCHEMAS & CHANNELS (BOARD PRIMITIVES)
   * ====================================================================== */

  public createGrant(
    tenantId: string,
    actorId: string,
    params: { id?: string; principal: string; path: string; can: string[] },
  ): GrantRecord {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const actor = this.requirePrincipal(tId, actorId);
      if (actor.kind !== "human" || (actor.role !== "owner" && actor.role !== "lead")) {
        throw new ForbiddenError("only human owners/leads can create grants");
      }
      const id =
        params.id ??
        "g" +
          (Number(
            (
              this.store.db
                .prepare("SELECT COUNT(*) AS n FROM grant_rule WHERE tenant_id = ?")
                .get(tId) as { n: number }
            ).n,
          ) +
            1 +
            Math.floor(Math.random() * 90));
      const now = this.now();
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO grant_rule (id, tenant_id, principal, path, can_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(tId === tenantId ? id : id, tId, params.principal, params.path, JSON.stringify(params.can), actorId, now);
      this.appendEvent(tId, {
        kind: "grant.created",
        actor: actorId,
        channel: null,
        taskId: null,
        payload: { id, principal: params.principal, path: params.path, can: params.can },
      });
      return {
        id,
        tenantId: tId,
        principal: params.principal,
        path: params.path,
        can: params.can,
        createdBy: actorId,
        createdAt: now,
      };
    });
  }

  public revokeGrant(tenantId: string, actorId: string, grantId: string): void {
    const tId = this.store.assertTenant(tenantId);
    this.store.tx(() => {
      const actor = this.requirePrincipal(tId, actorId);
      if (actor.kind !== "human" || (actor.role !== "owner" && actor.role !== "lead")) {
        throw new ForbiddenError("only human owners/leads can revoke grants");
      }
      const res = this.store.db
        .prepare("DELETE FROM grant_rule WHERE tenant_id = ? AND id = ?")
        .run(tId, grantId);
      if (res.changes === 0) throw new ValidationError(`no such grant: ${grantId}`);
      this.appendEvent(tId, {
        kind: "grant.revoked",
        actor: actorId,
        channel: null,
        taskId: null,
        payload: { grantId },
      });
    });
  }

  public listGrants(tenantId: string): GrantRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM grant_rule WHERE tenant_id = ? ORDER BY created_at ASC, id ASC")
      .all(tId) as {
      id: string;
      tenant_id: string;
      principal: string;
      path: string;
      can_json: string;
      created_by: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      principal: r.principal,
      path: r.path,
      can: JSON.parse(r.can_json) as string[],
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
    }));
  }

  public explainAccess(
    tenantId: string,
    principalId: string,
    channelOrPath: string,
    op: "read" | "post",
  ) {
    const tId = this.store.assertTenant(tenantId);
    return explainGrant(this.listGrants(tId), principalId, channelOrPath, op);
  }

  private requireChannelAccess(
    tenantId: string,
    principalId: string,
    channel: string,
    op: "read" | "post",
  ) {
    const exp = this.explainAccess(tenantId, principalId, channel, op);
    if (!exp.ok) {
      throw new ForbiddenError(
        `${principalId} denied ${op} on ${channel}/ (${exp.why})`,
      );
    }
  }

  public registerSchema(tenantId: string, schema: Omit<SchemaRecord, "tenantId">): SchemaRecord {
    const tId = this.store.assertTenant(tenantId);
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO schema_def (name, tenant_id, description, required_json, enums_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        schema.name,
        tId,
        schema.description,
        JSON.stringify(schema.required),
        JSON.stringify(schema.enums),
      );
    return { ...schema, tenantId: tId };
  }

  public listSchemas(tenantId: string): SchemaRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM schema_def WHERE tenant_id = ? ORDER BY name ASC")
      .all(tId) as {
      name: string;
      tenant_id: string;
      description: string;
      required_json: string;
      enums_json: string;
    }[];
    return rows.map((r) => ({
      name: r.name,
      tenantId: r.tenant_id,
      description: r.description,
      required: JSON.parse(r.required_json) as string[],
      enums: JSON.parse(r.enums_json) as Record<string, string[]>,
    }));
  }

  public validateSchemaPayload(
    tenantId: string,
    schemaName: string,
    data: unknown,
  ): Record<string, unknown> {
    const tId = this.store.assertTenant(tenantId);
    const sc = this.listSchemas(tId).find((s) => s.name === schemaName);
    if (!sc) throw new ValidationError(`unknown schema "${schemaName}"`);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ValidationError("schema payload must be a JSON object");
    }
    const obj = data as Record<string, unknown>;
    for (const req of sc.required) {
      if (!(req in obj)) {
        throw new ValidationError(`schema ${schemaName}: missing required field "${req}"`);
      }
    }
    for (const [k, allowed] of Object.entries(sc.enums)) {
      if (k in obj && !allowed.includes(String(obj[k]))) {
        throw new ValidationError(
          `schema ${schemaName}: field "${k}" must be one of ${allowed.join("|")}`,
        );
      }
    }
    return obj;
  }

  public ensureChannelRoom(
    tenantId: string,
    params: {
      name: string;
      kind?: "channel" | "branch";
      repo?: string;
      branch?: string;
      origin?: string;
      createdBy: string;
    },
  ): ChannelRoom {
    const tId = this.store.assertTenant(tenantId);
    const now = this.now();
    const kind = params.kind ?? (params.name.startsWith("branch/") ? "branch" : "channel");
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO channel_room (name, tenant_id, kind, repo, branch, origin, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.name,
        tId,
        kind,
        params.repo ?? null,
        params.branch ?? null,
        params.origin ?? "hive",
        params.createdBy,
        now,
      );
    const r = this.store.db
      .prepare("SELECT * FROM channel_room WHERE tenant_id = ? AND name = ?")
      .get(tId, params.name) as {
      name: string;
      tenant_id: string;
      kind: "channel" | "branch";
      repo: string | null;
      branch: string | null;
      origin: string;
      created_by: string;
      created_at: number;
    };
    return {
      name: r.name,
      tenantId: r.tenant_id,
      kind: r.kind,
      repo: r.repo,
      branch: r.branch,
      origin: r.origin,
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
    };
  }

  public listChannelRooms(tenantId: string): ChannelRoom[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM channel_room WHERE tenant_id = ? ORDER BY kind ASC, created_at ASC")
      .all(tId) as {
      name: string;
      tenant_id: string;
      kind: "channel" | "branch";
      repo: string | null;
      branch: string | null;
      origin: string;
      created_by: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      name: r.name,
      tenantId: r.tenant_id,
      kind: r.kind,
      repo: r.repo,
      branch: r.branch,
      origin: r.origin,
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
    }));
  }

  /* ========================================================================
   *  SIGNED HASH-CHAINED EVENT LOG, SEARCH & CHECKPOINTS
   * ====================================================================== */

  public appendEvent(
    tenantId: string,
    params: {
      kind: string;
      actor: string;
      channel: string | null;
      taskId: string | null;
      payload: Record<string, unknown>;
      trust?: Trust;
      attest?: string[];
    },
  ): EventRecord {
    const tId = this.store.assertTenant(tenantId);
    const prevRow = this.store.db
      .prepare("SELECT id FROM event WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1")
      .get(tId) as { id: string } | undefined;
    const prev = prevRow?.id ?? "genesis";
    const createdAt = this.now();

    const principalRow = this.getPrincipalWithSecret(tId, params.actor);
    const trust: Trust =
      params.trust ??
      (principalRow
        ? principalRow.kind === "human" && principalRow.role === "owner"
          ? "owner"
          : "member"
        : "external");

    const attest = params.attest ?? [];
    const id = computeEventId({
      prev,
      tenantId: tId,
      kind: params.kind,
      actor: params.actor,
      channel: params.channel,
      taskId: params.taskId,
      trust,
      payload: params.payload,
      createdAt,
      attest,
    });

    const signerKey = principalRow ? principalRow.privkey : this.store.gatewaySigningKey();
    this.mutationEpoch += 1;
    const sig = signEd25519(signerKey, id);

    const info = this.store.db
      .prepare(
        `INSERT INTO event (tenant_id, id, prev, kind, actor, channel, task_id, payload_json, trust, attest_json, sig, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tId,
        id,
        prev,
        params.kind,
        params.actor,
        params.channel,
        params.taskId,
        canonicalJson(params.payload),
        trust,
        JSON.stringify(attest),
        sig,
        createdAt,
      );

    const seq = Number(info.lastInsertRowid);
    const searchableText = [
      params.kind,
      params.actor,
      params.channel ?? "",
      params.taskId ?? "",
      typeof params.payload.text === "string"
        ? params.payload.text
        : canonicalJson(params.payload),
    ].join(" ");

    this.store.db
      .prepare(
        `INSERT INTO event_fts (event_id, tenant_id, kind, actor, channel, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tId, params.kind, params.actor, params.channel ?? "", searchableText);

    const record: EventRecord = {
      seq,
      tenantId: tId,
      id,
      prev,
      kind: params.kind,
      actor: params.actor,
      channel: params.channel,
      taskId: params.taskId,
      payload: params.payload,
      trust,
      attest,
      sig,
      createdAt,
    };
    // Fan out only after the enclosing transaction commits (survives ROLLBACK as silence).
    this.store.onCommit(() => this.emitEvent(record));
    return record;
  }

  /** Subscribe to committed events. Returns an unsubscribe function. */
  public onEvent(cb: (ev: EventRecord) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private emitEvent(ev: EventRecord): void {
    for (const cb of this.eventListeners) {
      try {
        cb(ev);
      } catch (err) {
        console.error("[hive-kernel] event listener failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  public listEvents(
    tenantId: string,
    opts?: { channel?: string; taskId?: string; sinceSeq?: number; limit?: number },
  ): EventRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const clauses = ["tenant_id = ?"];
    const args: (string | number)[] = [tId];
    if (opts?.channel) {
      clauses.push("channel = ?");
      args.push(opts.channel);
    }
    if (opts?.taskId) {
      clauses.push("task_id = ?");
      args.push(opts.taskId);
    }
    if (opts?.sinceSeq !== undefined) {
      clauses.push("seq > ?");
      args.push(opts.sinceSeq);
    }
    const limit = opts?.limit ?? 200;
    const rows = this.store.db
      .prepare(
        `SELECT * FROM event WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
      )
      .all(...args, limit) as {
      seq: number;
      tenant_id: string;
      id: string;
      prev: string;
      kind: string;
      actor: string;
      channel: string | null;
      task_id: string | null;
      payload_json: string;
      trust: Trust;
      attest_json: string;
      sig: string;
      created_at: number;
    }[];
    return rows.map((r) => this.mapEventRow(r));
  }

  private mapEventRow(r: {
    seq: number;
    tenant_id: string;
    id: string;
    prev: string;
    kind: string;
    actor: string;
    channel: string | null;
    task_id: string | null;
    payload_json: string;
    trust: Trust;
    attest_json: string;
    sig: string;
    created_at: number;
  }): EventRecord {
    return {
      seq: Number(r.seq),
      tenantId: r.tenant_id,
      id: r.id,
      prev: r.prev,
      kind: r.kind,
      actor: r.actor,
      channel: r.channel,
      taskId: r.task_id,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      trust: r.trust,
      attest: JSON.parse(r.attest_json) as string[],
      sig: r.sig,
      createdAt: Number(r.created_at),
    };
  }

  public searchEvents(tenantId: string, query: string): EventRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const terms = query
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9_.-]/g, ""))
      .filter((w) => w.length >= 2);
    if (!terms.length) return [];

    const ftsQuery = terms.map((t) => `"${t}"*`).join(" OR ");
    const hits = this.store.db
      .prepare(
        `SELECT event_id FROM event_fts WHERE event_fts MATCH ? AND tenant_id = ? LIMIT 50`,
      )
      .all(ftsQuery, tId) as { event_id: string }[];
    if (!hits.length) return [];
    const ids = new Set(hits.map((h) => h.event_id));
    return this.listEvents(tId, { limit: 500 })
      .filter((e) => ids.has(e.id))
      .reverse();
  }

  public createCheckpoint(tenantId: string): CheckpointRecord {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const evs = this.listEvents(tId, { limit: 10000 });
      const uptoSeq = evs.length ? evs[evs.length - 1].seq : 0;
      const headEventId = evs.length ? evs[evs.length - 1].id : "genesis";
      const root = merkleRoot(evs.map((e) => e.id));
      const meta = this.store.getMeta();
      const createdAt = this.now();
      const id = `chk_${uptoSeq}_${root.slice(0, 10)}`;
      const preimage = canonicalJson({
        id,
        tenantId: tId,
        uptoSeq,
        headEventId,
        merkleRoot: root,
        incarnation: meta.incarnation,
      });
      const sig = signEd25519(this.store.gatewaySigningKey(), preimage);
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO checkpoint (id, tenant_id, upto_seq, head_event_id, merkle_root, incarnation, sig, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, tId, uptoSeq, headEventId, root, meta.incarnation, sig, createdAt);
      return {
        id,
        tenantId: tId,
        uptoSeq,
        headEventId,
        merkleRoot: root,
        incarnation: meta.incarnation,
        sig,
        createdAt,
      };
    });
  }

  public listCheckpoints(tenantId: string): CheckpointRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM checkpoint WHERE tenant_id = ? ORDER BY upto_seq DESC")
      .all(tId) as {
      id: string;
      tenant_id: string;
      upto_seq: number;
      head_event_id: string;
      merkle_root: string;
      incarnation: string;
      sig: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      uptoSeq: Number(r.upto_seq),
      headEventId: r.head_event_id,
      merkleRoot: r.merkle_root,
      incarnation: r.incarnation,
      sig: r.sig,
      createdAt: Number(r.created_at),
    }));
  }

  /**
   * Cryptographic verification of the entire hash-chained event log + Ed25519 signatures + checkpoint.
   */
  public verifyLog(tenantId: string, checkpointSelector?: string): LogVerifyResult {
    const tId = this.store.assertTenant(tenantId);
    const meta = this.store.getMeta();
    // Other connections (drills, future PG runtime) don't bump mutationEpoch —
    // data_version does. Same-connection writes are covered by mutationEpoch.
    let dataVersion = 0;
    try {
      const row = this.store.db.prepare("PRAGMA data_version").get() as { data_version?: number } | undefined;
      dataVersion = row && typeof row.data_version === "number" ? row.data_version : 0;
    } catch {
      dataVersion = 0;
    }

    // Resolve the checkpoint selector up-front so the cache key fully determines the result.
    let chkId: string | null = null;
    if (checkpointSelector) {
      const chks = this.listCheckpoints(tId);
      const chk =
        checkpointSelector === "latest"
          ? chks[0]
          : chks.find((c) => c.id === checkpointSelector);
      chkId = chk ? chk.id : `missing:${checkpointSelector}`;
    }
    const cacheKey = `${tId}:${checkpointSelector ?? "none"}:${chkId ?? "none"}:${this.mutationEpoch}:${meta.incarnation}:${dataVersion}`;
    const cached = this.logVerifyCache.get(cacheKey);
    if (cached) return cached;

    const result = this.verifyLogUncached(tId, checkpointSelector);
    if (this.logVerifyCache.size >= HiveKernel.LOG_VERIFY_CACHE_LIMIT) {
      this.logVerifyCache.delete(this.logVerifyCache.keys().next().value!);
    }
    this.logVerifyCache.set(cacheKey, result);
    return result;
  }

  private verifyLogUncached(tenantId: string, checkpointSelector?: string): LogVerifyResult {
    const tId = tenantId;
    const meta = this.store.getMeta();
    const evs = this.listEvents(tId, { limit: 50000 });
    let expectedPrev = "genesis";
    // Memoized Ed25519 verify makes repeated snapshots cheap even on full re-verification.

    for (const ev of evs) {
      if (ev.prev !== expectedPrev) {
        return {
          ok: false,
          checkedEvents: ev.seq,
          checkpointVerified: false,
          badSeq: ev.seq,
          badEventId: ev.id,
          reason: `prev-hash link broken at seq ${ev.seq}: expected ${expectedPrev}, got ${ev.prev}`,
        };
      }
      const recomputedId = computeEventId({
        prev: ev.prev,
        tenantId: ev.tenantId,
        kind: ev.kind,
        actor: ev.actor,
        channel: ev.channel,
        taskId: ev.taskId,
        trust: ev.trust,
        payload: ev.payload,
        createdAt: ev.createdAt,
        attest: ev.attest,
      });
      if (recomputedId !== ev.id) {
        return {
          ok: false,
          checkedEvents: ev.seq,
          checkpointVerified: false,
          badSeq: ev.seq,
          badEventId: ev.id,
          reason: `content hash mismatch at seq ${ev.seq}: payload tampered after signing`,
        };
      }
      const p = this.getPrincipal(tId, ev.actor);
      const pubkey = p ? p.pubkey : meta.gatewayPub;
      if (!verifyEd25519(pubkey, ev.id, ev.sig)) {
        return {
          ok: false,
          checkedEvents: ev.seq,
          checkpointVerified: false,
          badSeq: ev.seq,
          badEventId: ev.id,
          reason: `Ed25519 signature invalid at seq ${ev.seq} (actor: ${ev.actor})`,
        };
      }
      expectedPrev = ev.id;
    }

    if (checkpointSelector) {
      const chks = this.listCheckpoints(tId);
      const chk =
        checkpointSelector === "latest"
          ? chks[0]
          : chks.find((c) => c.id === checkpointSelector);
      if (chk) {
        const maxSeq = evs.length > 0 ? evs[evs.length - 1].seq : 0;
        // Tail-truncation bound: a checkpoint covering seq U cannot outlive the
        // deletion of tail events — if the log ends BEFORE the checkpoint claims to,
        // rows were deleted underneath it. Reject.
        if (chk.uptoSeq > maxSeq) {
          return {
            ok: false,
            checkedEvents: evs.length,
            checkpointVerified: false,
            checkpointId: chk.id,
            reason: `checkpoint ${chk.id} covers seq ${chk.uptoSeq} but the log ends at ${maxSeq} — tail truncation suspected`,
          };
        }
        // The checkpoint's head binding must match the actual event at seq = uptoSeq.
        const headEv = chk.uptoSeq > 0 ? evs.find((e) => e.seq === chk.uptoSeq) : undefined;
        if (chk.uptoSeq > 0 && headEv && headEv.id !== chk.headEventId) {
          return {
            ok: false,
            checkedEvents: evs.length,
            checkpointVerified: false,
            checkpointId: chk.id,
            reason: `checkpoint ${chk.id} head_event_id does not match the event at seq ${chk.uptoSeq}`,
          };
        }
        const subset = evs.filter((e) => e.seq <= chk.uptoSeq);
        const expectedRoot = merkleRoot(subset.map((e) => e.id));
        const preimage = canonicalJson({
          id: chk.id,
          tenantId: chk.tenantId,
          uptoSeq: chk.uptoSeq,
          headEventId: chk.headEventId,
          merkleRoot: chk.merkleRoot,
          incarnation: chk.incarnation,
        });
        if (
          expectedRoot !== chk.merkleRoot ||
          !verifyEd25519(meta.gatewayPub, preimage, chk.sig)
        ) {
          return {
            ok: false,
            checkedEvents: evs.length,
            checkpointVerified: false,
            checkpointId: chk.id,
            reason: `checkpoint ${chk.id} Merkle root or signature mismatch`,
          };
        }
        return {
          ok: true,
          checkedEvents: evs.length,
          checkpointVerified: true,
          checkpointId: chk.id,
        };
      }
    }

    return {
      ok: true,
      checkedEvents: evs.length,
      checkpointVerified: false,
    };
  }

  /**
   * Controlled tamper drill (used by UI & `log.tamper.spec` to prove tamper detection).
   */
  public tamperEventForDrill(tenantId: string, seq: number, newText: string): void {
    const tId = this.store.assertTenant(tenantId);
    const row = this.store.db
      .prepare("SELECT payload_json FROM event WHERE tenant_id = ? AND seq = ?")
      .get(tId, seq) as { payload_json: string } | undefined;
    if (!row) throw new ValidationError(`no event at seq ${seq}`);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.tampered = newText;
    this.mutationEpoch += 1;
    this.store.db
      .prepare("UPDATE event SET payload_json = ? WHERE tenant_id = ? AND seq = ?")
      .run(canonicalJson(payload), tId, seq);
  }

  /* ========================================================================
   *  INGEST & PROJECTION CHAT (PRINCIPLE 1 & ALGORITHM 4)
   * ====================================================================== */

  public ingestMessage(tenantId: string, raw: RawInboundInput): InboundMessage {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const known = this.getPrincipal(tId, raw.principalId);
      const inbound = ingestInbound({ ...raw, knownPrincipal: known });
      this.ensureChannelRoom(tId, {
        name: raw.channel,
        origin: raw.source,
        createdBy: raw.principalId,
      });

      this.appendEvent(tId, {
        kind: "ingest.message",
        actor: raw.principalId,
        channel: raw.channel,
        taskId: null,
        trust: inbound.trust,
        payload: {
          source: inbound.source,
          text: inbound.text,
          renderedForAgent: inbound.renderedForAgent,
          flags: inbound.flags,
          externalRef: inbound.externalRef,
        },
      });

      if (inbound.trust === "external" && inbound.flags.instructionLike) {
        this.appendEvent(tId, {
          kind: "security.injection_quarantined",
          actor: "hive-policy",
          channel: raw.channel,
          taskId: null,
          trust: "owner",
          payload: {
            offendingPrincipal: inbound.principal,
            source: inbound.source,
            matchedSpans: inbound.flags.matchedSpans,
            action: "quoted_as_untrusted_data_no_instruct_capability",
          },
        });
      }
      return inbound;
    });
  }

  /**
   * Discussion post (Projection only! Never transitions task state — Principle 1).
   */
  public postChannelMessage(
    tenantId: string,
    params: {
      actor: string;
      channel: string;
      taskId?: string;
      text: string;
      schema?: string;
      data?: unknown;
      token?: string;
      noSync?: boolean;
    },
  ): EventRecord {
    const tId = this.store.assertTenant(tenantId);
    let attestChain: string[] = [];
    if (params.token) {
      if (params.taskId) {
        const g = this.guardedTask(tId, params.token, params.taskId, "chat.post");
        attestChain = g.claims.chain;
      } else {
        const claims = this.verifyCap(tId, params.token, "chat.post");
        attestChain = claims.chain;
      }
    } else {
      // Agents without a token may only chat under attestation scope — and never on
      // a task thread (that path implies lease ownership). Humans act via attestation-free
      // root authz. HTTP callers are bound to an authenticated session before this point.
      const caller = this.getPrincipal(tId, params.actor);
      if (caller?.kind === "agent" && params.taskId) {
        throw new ForbiddenError(
          `agent "${params.actor}" must present a lease-scoped hct_ capability token to post on task #${params.taskId}`,
        );
      }
      const auth = this.authorizePrincipal(tId, params.actor, "chat.post");
      attestChain = auth.attestChain;
    }
    return this.store.tx(() => {
      this.requireChannelAccess(tId, params.actor, params.channel, "post");
      enforceOutboundDlp(params.text);
      let validatedData: Record<string, unknown> | undefined;
      if (params.schema) {
        validatedData = this.validateSchemaPayload(tId, params.schema, params.data);
        enforceOutboundDlp(canonicalJson(validatedData));
      }
      this.ensureChannelRoom(tId, { name: params.channel, createdBy: params.actor });
      const ev = this.appendEvent(tId, {
        kind: "chat.message",
        actor: params.actor,
        channel: params.channel,
        taskId: params.taskId ?? null,
        attest: attestChain,
        payload: {
          text: params.text,
          schema: params.schema,
          data: validatedData,
          noSync: Boolean(params.noSync),
        },
      });
      return ev;
    });
  }

  /* ========================================================================
   *  AUTHORITY KERNEL: 12-STATE TASK LIFECYCLE, CAS & LEASE FENCING
   * ====================================================================== */

  public createTask(
    tenantId: string,
    params: {
      id?: string;
      actor: string;
      channel: string;
      title: string;
      goalId?: string;
      deps?: string[];
      budgetCapCents?: number;
      protectedPath?: string;
      gatePolicy?: GatePolicy;
      labels?: Record<string, string>;
      fromInbound?: InboundMessage;
      originOperationId?: string;
    },
  ): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      if (params.actor !== "ingest") {
        this.authorizePrincipal(tId, params.actor, "task.create");
        this.requireChannelAccess(tId, params.actor, params.channel, "post");
      }
      this.ensureChannelRoom(tId, { name: params.channel, createdBy: params.actor });

      const countRow = this.store.db
        .prepare("SELECT COUNT(*) AS n FROM task WHERE tenant_id = ?")
        .get(tId) as { n: number };
      const id = params.id ?? String(801 + Number(countRow.n));

      const deps = params.deps ?? [];
      const allDepsClosed = deps.every((depId) => {
        const dt = this.findTask(tId, depId);
        return dt !== undefined && dt.state === "closed" && Boolean(dt.verifiedClose);
      });
      const initialState: TaskState = deps.length > 0 && !allDepsClosed ? "blocked" : "ready";
      const gatePolicy = resolveGatePolicyForPath(params.protectedPath, params.gatePolicy);
      const trust: Trust = params.fromInbound?.trust ?? "member";
      const now = this.now();
      const originOp = params.originOperationId ?? `op_${id}_${now}`;

      this.store.db
        .prepare(
          `INSERT INTO task (
            id, tenant_id, goal_id, channel, branch_room, title, state, owner,
            lease_epoch, lease_until, attempt, budget_cap_cents, budget_spent,
            revision, origin_operation_id, trust, head_sha, protected_path,
            gate_policy, verified_close, labels_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 0, NULL, 0, ?, 0, 1, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          tId,
          params.goalId ?? null,
          params.channel,
          params.title,
          initialState,
          params.budgetCapCents ?? 500,
          originOp,
          trust,
          params.protectedPath ?? null,
          gatePolicy,
          JSON.stringify(params.labels ?? { kind: "bug" }),
          now,
          now,
        );

      for (const depId of deps) {
        this.store.db
          .prepare("INSERT INTO task_dep (tenant_id, task_id, dep_id) VALUES (?, ?, ?)")
          .run(tId, id, depId);
      }

      this.appendEvent(tId, {
        kind: "task.created",
        actor: params.actor,
        channel: params.channel,
        taskId: id,
        trust,
        payload: {
          taskId: id,
          title: params.title,
          state: initialState,
          deps,
          gatePolicy,
          protectedPath: params.protectedPath ?? null,
          budgetCapCents: params.budgetCapCents ?? 500,
        },
      });

      if (initialState === "ready") {
        this.enqueueEligibleWorkerWake(tId, id, params.channel, "task.ready");
      }

      return this.getTask(tId, id);
    });
  }

  private enqueueEligibleWorkerWake(
    tenantId: string,
    taskId: string,
    channel: string,
    reason: string,
  ) {
    const workers = this.listPrincipals(tenantId).filter(
      (p) =>
        p.kind === "agent" &&
        p.role === "worker" &&
        !p.attestation?.revoked &&
        this.explainAccess(tenantId, p.id, channel, "post").ok,
    );
    if (workers.length > 0) {
      this.enqueueWake(tenantId, {
        principal: workers[0].id,
        taskId,
        channel,
        reason,
      });
    }
  }

  /**
   * Algorithm 1 · Claim with a fencing epoch (Compare-and-Swap) + Gateway Capability Token.
   */
  public claimTask(
    tenantId: string,
    params: {
      taskId?: string;
      channel?: string;
      labelFilter?: { key: string; value: string };
      actor: string;
      ttlMs?: number;
    },
  ): { task: TaskRecord; epoch: number; token: string } {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const { principal, attestChain } = this.authorizePrincipal(tId, params.actor, "task.claim");
      // Minted capability ops are the INTERSECTION of the static mint list with the
      // agent's Owner Attestation scope — an agent attested only for patch:fix/*
      // cannot be handed effect:post-github authority.
      let mintableOps = [
        "chat.post",
        "task.renew",
        "task.submit",
        "patch:fix/*",
        "effect:open-pr",
        "effect:open-branch",
        "effect:post-slack",
        "effect:post-github",
      ];
      if (principal.kind === "agent") {
        const scope = principal.attestation?.scope ?? [];
        mintableOps = mintableOps.filter((op) => scope.some((pat) => matchScopePattern(pat, op)));
        if (mintableOps.length === 0) {
          throw new ForbiddenError(
            `agent "${principal.id}" attestation scope cannot mint any task capability`,
          );
        }
      }

      let target: TaskRecord | undefined;
      if (params.taskId) {
        target = this.getTask(tId, params.taskId);
      } else if (params.channel) {
        target = this.listTasks(tId).find(
          (t) =>
            t.channel === params.channel &&
            t.state === "ready" &&
            (!params.labelFilter ||
              t.labels[params.labelFilter.key] === params.labelFilter.value),
        );
        if (!target) {
          throw new ConflictError(`no ready task matching filter in ${params.channel}`);
        }
      } else {
        throw new ValidationError("claimTask requires taskId or channel");
      }

      this.requireChannelAccess(tId, params.actor, target.channel, "post");
      if (target.state !== "ready") {
        throw new ConflictError(
          `task #${target.id} is not claimable (current state: ${target.state})`,
        );
      }

      const ttlMs = params.ttlMs ?? 30 * 60 * 1000;
      const now = this.now();
      const epoch = target.leaseEpoch + 1;
      const leaseUntil = now + ttlMs;

      // Compare-and-Swap on (tenant_id, id, revision, state='ready')
      const res = this.store.db
        .prepare(
          `UPDATE task
           SET state = 'claimed',
               owner = ?,
               lease_epoch = ?,
               lease_until = ?,
               revision = revision + 1,
               updated_at = ?
           WHERE tenant_id = ? AND id = ? AND revision = ? AND state = 'ready'`,
        )
        .run(params.actor, epoch, leaseUntil, now, tId, target.id, target.revision);

      if (res.changes !== 1) {
        throw new ConflictError(`lost CAS race claiming task #${target.id}`);
      }

      const meta = this.store.getMeta();
      const token = mintCapabilityToken(
        {
          sub: params.actor,
          tenant: tId,
          incarnation: meta.incarnation,
          task: target.id,
          epoch,
          ops: mintableOps,
          budgetCents: target.budgetCapCents,
          notAfter: leaseUntil,
          chain: attestChain,
        },
        this.store.gatewaySigningKey(),
      );

      this.appendEvent(tId, {
        kind: "task.claimed",
        actor: params.actor,
        channel: target.channel,
        taskId: target.id,
        attest: attestChain,
        payload: {
          taskId: target.id,
          owner: params.actor,
          epoch,
          leaseUntil,
          budgetCapCents: target.budgetCapCents,
        },
      });

      return { task: this.getTask(tId, target.id), epoch, token };
    });
  }

  public verifyCap(tenantId: string, token: string, requiredOp: string): CapabilityClaims {
    const tId = this.store.assertTenant(tenantId);
    const meta = this.store.getMeta();
    const claims = verifyCapabilityToken(
      token,
      meta.gatewayPub,
      tId,
      meta.incarnation,
      this.now(),
    );
    // Also verify live principal attestation hasn't been revoked since minting!
    this.authorizePrincipal(tId, claims.sub, requiredOp);
    assertCapabilityAllows(claims, requiredOp);
    return claims;
  }

  /**
   * Algorithm 1b · Server-side Lease Epoch Fencing Guard.
   * Every task mutation & agent side effect MUST pass through this guard.
   */
  public guardedTask(
    tenantId: string,
    token: string,
    taskId: string,
    requiredOp: string,
  ): { task: TaskRecord; claims: CapabilityClaims } {
    const tId = this.store.assertTenant(tenantId);
    const meta = this.store.getMeta();
    const claims = verifyCapabilityToken(
      token,
      meta.gatewayPub,
      tId,
      meta.incarnation,
      this.now(),
    );
    assertCapabilityAllows(claims, requiredOp);
    if (claims.task !== taskId) {
      throw new ForbiddenError(
        `capability token is scoped to task #${claims.task ?? "none"}, not #${taskId}`,
      );
    }

    const task = this.getTask(tId, taskId);

    if (claims.epoch !== task.leaseEpoch) {
      this.appendEvent(tId, {
        kind: "fence.rejected",
        actor: claims.sub,
        channel: task.channel,
        taskId: task.id,
        payload: {
          attemptedOp: requiredOp,
          tokenEpoch: claims.epoch,
          currentEpoch: task.leaseEpoch,
          reason: `stale lease_epoch ${claims.epoch} < ${task.leaseEpoch}`,
        },
      });
      throw new FencedError(
        `409 Fenced: stale lease_epoch ${claims.epoch} !== current ${task.leaseEpoch}`,
      );
    }

    if (task.state === "halted") {
      throw new HaltedError(
        `task #${taskId} is halted by circuit breaker (spent ${task.budgetSpent}/${task.budgetCapCents} cents)`,
      );
    }

    if (task.state !== "claimed") {
      throw new FencedError(
        `409 Fenced: task #${taskId} is in state "${task.state}", not actively leased`,
      );
    }

    if (task.leaseUntil !== null && this.now() > task.leaseUntil) {
      throw new FencedError(`409 Fenced: lease on task #${taskId} has expired`);
    }

    // Re-check principal attestation was not revoked mid-lease
    this.authorizePrincipal(tId, claims.sub, requiredOp);

    return { task, claims };
  }

  /**
   * Hook-driven lease renewal (never depends on LLM prompt memory).
   */
  public renewLease(
    tenantId: string,
    params: { taskId: string; token: string; ttlMs?: number },
  ): { task: TaskRecord; token: string } {
    const tId = this.store.assertTenant(tenantId);
    const { task, claims } = this.guardedTask(tId, params.token, params.taskId, "task.renew");
    return this.store.tx(() => {
      const ttlMs = params.ttlMs ?? 30 * 60 * 1000;
      const now = this.now();
      const leaseUntil = now + ttlMs;

      const res = this.store.db
        .prepare(
          `UPDATE task
           SET lease_until = ?, revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND revision = ? AND lease_epoch = ?`,
        )
        .run(leaseUntil, now, tId, task.id, task.revision, task.leaseEpoch);
      if (res.changes !== 1) throw new ConflictError("CAS conflict renewing lease");

      const newToken = mintCapabilityToken(
        { ...claims, notAfter: leaseUntil },
        this.store.gatewaySigningKey(),
      );

      this.appendEvent(tId, {
        kind: "task.lease_renewed",
        actor: claims.sub,
        channel: task.channel,
        taskId: task.id,
        attest: claims.chain,
        payload: { epoch: task.leaseEpoch, leaseUntil },
      });

      return { task: this.getTask(tId, task.id), token: newToken };
    });
  }

  /**
   * Push a code patch / new commit head SHA to the task's branch room.
   * Invalidates any existing SHA-bound approvals AND resets verification if pushed
   * while awaiting_approval (closing the TOCTOU verification/approval gap!).
   */
  public pushPatch(
    tenantId: string,
    params: {
      taskId: string;
      headSha: string;
      diff: string;
      branch?: string;
      token?: string;
      actor?: string;
    },
  ): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    const initialTask = this.getTask(tId, params.taskId);
    let actor = params.actor ?? initialTask.owner ?? "unknown";
    let attestChain: string[] = [];

    if (params.token) {
      const g = this.guardedTask(tId, params.token, params.taskId, "patch:fix/*");
      actor = g.claims.sub;
      attestChain = g.claims.chain;
    } else {
      if (!params.actor) {
        throw new ForbiddenError("pushPatch requires a lease-scoped hct_ token or an authenticated actor");
      }
      const caller = this.getPrincipal(tId, actor);
      if (caller?.kind === "agent") {
        throw new ForbiddenError(
          `agent "${actor}" must present a lease-scoped hct_ capability token to push patches`,
        );
      }
      const auth = this.authorizePrincipal(tId, actor, "patch:fix/*");
      attestChain = auth.attestChain;
    }

    return this.store.tx(() => {
      const task = this.getTask(tId, params.taskId);

      enforceOutboundDlp(params.diff);
      const branch = params.branch ?? `fix/task-${task.id}`;
      const branchRoom = `branch/${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      this.ensureChannelRoom(tId, {
        name: branchRoom,
        kind: "branch",
        repo: "acme/www",
        branch,
        createdBy: actor,
      });

      const now = this.now();
      const shaChanged = task.headSha !== null && task.headSha !== params.headSha;

      // Invalidate any existing approvals whenever head SHA changes!
      if (shaChanged) {
        this.store.db
          .prepare(
            `UPDATE approval
             SET invalidated_at = ?, invalidated_reason = 'new_commit_pushed'
             WHERE tenant_id = ? AND task_id = ? AND invalidated_at IS NULL`,
          )
          .run(now, tId, task.id);
      }

      // TOCTOU hardening: if task was awaiting_approval or verifying on an older SHA,
      // force re-verification of the new SHA before any gate can pass!
      const nextState: TaskState =
        shaChanged && (task.state === "awaiting_approval" || task.state === "verifying")
          ? "verifying"
          : task.state;

      const res = this.store.db
        .prepare(
          `UPDATE task
           SET head_sha = ?, branch_room = ?, state = ?, revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND revision = ?`,
        )
        .run(params.headSha, branchRoom, nextState, now, tId, task.id, task.revision);
      if (res.changes !== 1) throw new ConflictError("CAS conflict updating task head_sha");

      this.appendEvent(tId, {
        kind: "patch.pushed",
        actor,
        channel: branchRoom,
        taskId: task.id,
        attest: attestChain,
        payload: {
          headSha: params.headSha,
          branch,
          diff: params.diff,
          invalidatedPriorApprovals: shaChanged,
        },
      });

      return this.getTask(tId, task.id);
    });
  }

  /**
   * Algorithm 7 · Per-task budget meter + loop signature detector (x6) + circuit breaker.
   */
  public meterCall(
    tenantId: string,
    params: {
      token: string;
      costCents: number;
      callSignature: string;
    },
  ): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    const meta = this.store.getMeta();
    const preClaims = verifyCapabilityToken(
      params.token,
      meta.gatewayPub,
      tId,
      meta.incarnation,
      this.now(),
    );
    if (!preClaims.task) throw new ValidationError("token has no task scope");
    const { task, claims } = this.guardedTask(tId, params.token, preClaims.task, "chat.post");
    let trippedError: HaltedError | null = null;

    this.store.tx(() => {
      const now = this.now();
      const spent = task.budgetSpent + params.costCents;

      this.store.db
        .prepare(
          `INSERT INTO call_telemetry (tenant_id, task_id, principal, lease_epoch, cost_cents, call_sig, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(tId, task.id, claims.sub, task.leaseEpoch, params.costCents, params.callSignature, now);

      // Count the streak across lease epochs: verify-fail -> re-claim bumps the
      // epoch, which previously reset the 6x breaker forever.
      const recent = this.store.db
        .prepare(
          `SELECT call_sig FROM call_telemetry
           WHERE tenant_id = ? AND task_id = ?
           ORDER BY id DESC LIMIT 6`,
        )
        .all(tId, task.id) as { call_sig: string }[];

      const loopDetected =
        recent.length >= 6 && recent.every((r) => r.call_sig === params.callSignature);
      const capHit = spent >= task.budgetCapCents;

      if (loopDetected || capHit) {
        this.store.db
          .prepare(
            `UPDATE task
             SET budget_spent = ?, state = 'halted', revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND revision = ?`,
          )
          .run(spent, now, tId, task.id, task.revision);

        this.appendEvent(tId, {
          kind: "task.halted",
          actor: "budget-breaker",
          channel: task.channel,
          taskId: task.id,
          payload: {
            spentCents: spent,
            capCents: task.budgetCapCents,
            loopDetected,
            repeatedSignature: loopDetected ? params.callSignature : undefined,
          },
        });

        trippedError = new HaltedError(
          loopDetected
            ? `circuit breaker tripped: repeated loop signature "${params.callSignature}" x6`
            : `budget cap reached (${spent}c >= ${task.budgetCapCents}c)`,
        );
      } else {
        this.store.db
          .prepare(
            `UPDATE task SET budget_spent = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
          )
          .run(spent, now, tId, task.id);
      }
    });

    if (trippedError) throw trippedError;
    return this.getTask(tId, claims.task!);
  }

  /**
   * Deterministic `/resume` verb: resets circuit breaker on a halted task with a new budget cap.
   */
  public resumeHaltedTask(
    tenantId: string,
    params: { actor: string; taskId: string; newCapCents: number; hint?: string },
  ): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const human = this.requirePrincipal(tId, params.actor);
      if (human.kind !== "human") {
        throw new ForbiddenError("only a human principal can /resume a halted task");
      }
      const task = this.getTask(tId, params.taskId);
      if (task.state !== "halted") {
        throw new ConflictError(`task #${task.id} is not halted (state: ${task.state})`);
      }
      if (params.newCapCents <= task.budgetSpent) {
        throw new ValidationError(
          `new budget cap (${params.newCapCents}c) must exceed current spend (${task.budgetSpent}c)`,
        );
      }
      const now = this.now();
      const leaseUntil = now + 30 * 60 * 1000;
      const res = this.store.db
        .prepare(
          `UPDATE task
           SET state = 'claimed', budget_cap_cents = ?, lease_until = ?, revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND revision = ? AND state = 'halted'`,
        )
        .run(params.newCapCents, leaseUntil, now, tId, task.id, task.revision);
      if (res.changes !== 1) throw new ConflictError("CAS conflict resuming task");

      // Clear loop streak so resumed worker gets a clean slate with the human hint
      this.store.db
        .prepare("DELETE FROM call_telemetry WHERE tenant_id = ? AND task_id = ?")
        .run(tId, task.id);

      this.appendEvent(tId, {
        kind: "task.resumed",
        actor: params.actor,
        channel: task.channel,
        taskId: task.id,
        payload: { newCapCents: params.newCapCents, hint: params.hint },
      });

      if (task.owner) {
        this.enqueueWake(tId, {
          principal: task.owner,
          taskId: task.id,
          channel: task.channel,
          reason: `resumed by ${params.actor}${params.hint ? `: ${params.hint}` : ""}`,
        });
      }

      return this.getTask(tId, task.id);
    });
  }

  /**
   * Algorithm 2 (Part 1) · Submit work with evidence references.
   * Moves task `claimed -> submitted -> verifying` and wakes a NON-AUTHOR verifier!
   */
  public submitTask(
    tenantId: string,
    params: {
      taskId: string;
      token: string;
      headSha?: string;
      evidenceRefs: string[];
      summary?: string;
    },
  ): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    const { task, claims } = this.guardedTask(
      tId,
      params.token,
      params.taskId,
      "task.submit",
    );
    return this.store.tx(() => {
      const headSha =
        params.headSha ??
        task.headSha ??
        sha256(`${task.id}:${task.leaseEpoch}:${task.attempt}`).slice(0, 12);
      const now = this.now();

      const res = this.store.db
        .prepare(
          `UPDATE task
           SET state = 'submitted', head_sha = ?, revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND revision = ? AND lease_epoch = ?`,
        )
        .run(headSha, now, tId, task.id, task.revision, task.leaseEpoch);
      if (res.changes !== 1) throw new ConflictError("CAS conflict submitting task");

      this.appendEvent(tId, {
        kind: "task.submitted",
        actor: claims.sub,
        channel: task.channel,
        taskId: task.id,
        attest: claims.chain,
        payload: {
          headSha,
          epoch: task.leaseEpoch,
          evidenceRefs: params.evidenceRefs,
          summary: params.summary ?? "Submitted for independent verification",
        },
      });

      // Immediately transition submitted -> verifying and wake a non-author verifier
      this.store.db
        .prepare(
          `UPDATE task SET state = 'verifying', revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(now, tId, task.id);

      const verifier = this.listPrincipals(tId).find(
        (p) =>
          p.id !== task.owner &&
          p.kind === "agent" &&
          p.attestation?.scope.includes("task.verify") &&
          !p.attestation.revoked,
      );

      this.appendEvent(tId, {
        kind: "task.verifying",
        actor: "hive-kernel",
        channel: task.channel,
        taskId: task.id,
        payload: {
          headSha,
          assignedVerifier: verifier?.id ?? "verifier",
        },
      });

      if (verifier) {
        this.enqueueWake(tId, {
          principal: verifier.id,
          taskId: task.id,
          channel: task.channel,
          reason: `verify:${headSha}`,
        });
      }

      return this.getTask(tId, task.id);
    });
  }

  /**
   * Algorithm 2 (Part 2) · Independent Verifier execution in clean tree-outside sandbox.
   * Author is strictly forbidden from verifying their own work!
   */
  public verifyTask(
    tenantId: string,
    params: {
      actor: string;
      taskId: string;
      headSha: string;
      result: "pass" | "fail";
      reproName?: string;
      details?: string;
    },
  ): { task: TaskRecord; evidence: EvidenceRecord } {
    const tId = this.store.assertTenant(tenantId);
    let staged = false;
    const result = this.store.tx(() => {
      const { attestChain } = this.authorizePrincipal(tId, params.actor, "task.verify");
      const task = this.getTask(tId, params.taskId);

      if (task.owner === params.actor) {
        throw new ForbiddenError(
          `author "${params.actor}" cannot verify own work on task #${task.id}`,
        );
      }
      if (task.state !== "verifying") {
        throw new ConflictError(
          `task #${task.id} is not awaiting verification (state: ${task.state})`,
        );
      }
      if (task.headSha !== params.headSha) {
        throw new ConflictError(
          `verification SHA mismatch (${params.headSha} !== current head ${task.headSha})`,
        );
      }

      const now = this.now();
      const evId = `ev_${task.id}_${task.attempt + 1}_${crypto.randomBytes(3).toString("hex")}`;
      const sandboxTree = `/var/hive/clean-sandbox/${task.id}/${params.headSha}`;
      const resultObj = {
        outcome: params.result,
        repro: params.reproName ?? "default-suite",
        details: params.details ?? (params.result === "pass" ? "Repro passed + CI green" : "Repro failed"),
      };
      const receiptHash = sha256(
        canonicalJson({
          taskId: task.id,
          headSha: params.headSha,
          leaseEpoch: task.leaseEpoch,
          producedBy: params.actor,
          sandboxTree,
          result: resultObj,
        }),
      );

      this.store.db
        .prepare(
          `INSERT INTO evidence
           (id, tenant_id, task_id, kind, head_sha, lease_epoch, result_json, passed, produced_by, sandbox_tree, receipt_hash, created_at)
           VALUES (?, ?, ?, 'clean_sandbox_repro', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evId,
          tId,
          task.id,
          params.headSha,
          task.leaseEpoch,
          canonicalJson(resultObj),
          params.result === "pass" ? 1 : 0,
          params.actor,
          sandboxTree,
          receiptHash,
          now,
        );

      const evidence: EvidenceRecord = {
        id: evId,
        tenantId: tId,
        taskId: task.id,
        kind: "clean_sandbox_repro",
        headSha: params.headSha,
        leaseEpoch: task.leaseEpoch,
        result: resultObj,
        passed: params.result === "pass",
        producedBy: params.actor,
        sandboxTree,
        receiptHash,
        createdAt: now,
      };

      if (params.result === "fail") {
        const nextAttempt = task.attempt + 1;
        // Hard cap on verify→reject→reclaim cycles (across lease epochs) so a
        // deterministically failing task cannot loop forever.
        if (nextAttempt >= MAX_ATTEMPTS) {
          this.store.db
            .prepare(
              `UPDATE task
               SET state = 'halted', attempt = ?, revision = revision + 1, updated_at = ?
               WHERE tenant_id = ? AND id = ? AND revision = ?`,
            )
            .run(nextAttempt, now, tId, task.id, task.revision);
          this.appendEvent(tId, {
            kind: "task.halted",
            actor: params.actor,
            channel: task.channel,
            taskId: task.id,
            attest: attestChain,
            payload: {
              reason: `attempt_cap_${nextAttempt}`,
              headSha: params.headSha,
              evidenceId: evId,
            },
          });
          return { task: this.getTask(tId, task.id), evidence };
        }
        this.store.db
          .prepare(
            `UPDATE task
             SET state = 'rejected', attempt = ?, revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND revision = ?`,
          )
          .run(nextAttempt, now, tId, task.id, task.revision);

        this.appendEvent(tId, {
          kind: "task.rejected",
          actor: params.actor,
          channel: task.channel,
          taskId: task.id,
          attest: attestChain,
          payload: {
            headSha: params.headSha,
            attempt: nextAttempt,
            evidenceId: evId,
            details: resultObj.details,
          },
        });

        // Re-queue rejected -> ready so worker can claim attempt N+1
        this.store.db
          .prepare(
            `UPDATE task
             SET state = 'ready', owner = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(now, tId, task.id);

        if (task.owner) {
          this.enqueueWake(tId, {
            principal: task.owner,
            taskId: task.id,
            channel: task.channel,
            reason: `repro_failed_attempt_${nextAttempt}: ${resultObj.details}`,
          });
        }
        return { task: this.getTask(tId, task.id), evidence };
      }

      // Verification PASSED!
      this.appendEvent(tId, {
        kind: "task.verified",
        actor: params.actor,
        channel: task.channel,
        taskId: task.id,
        attest: attestChain,
        payload: {
          headSha: params.headSha,
          evidenceId: evId,
          receiptHash,
          sandboxTree,
        },
      });

      const gate = gatePolicyForTask(task);
      if (gate !== "none") {
        this.store.db
          .prepare(
            `UPDATE task
             SET state = 'awaiting_approval', revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(now, tId, task.id);

        this.appendEvent(tId, {
          kind: "gate.requested",
          actor: "hive-kernel",
          channel: task.channel,
          taskId: task.id,
          payload: {
            headSha: params.headSha,
            gatePolicy: gate,
            protectedPath: task.protectedPath,
          },
        });

        return { task: this.getTask(tId, task.id), evidence };
      }

      // No human gate required -> stage idempotent merge; drained post-commit!
      this.completeMergeAndVerifiedClose(tId, task.id, "hive-kernel");
      staged = true;
      return { task: this.getTask(tId, task.id), evidence };
    });
    if (staged) this.finalizeVerifiedClose(tId, params.taskId, "hive-kernel");
    return { task: this.getTask(tId, params.taskId), evidence: result.evidence };
  }

  /**
   * Algorithm 3 · SHA-Bound Human Approval Gate (1-of-1 and 2-of-3 quorum).
   * Agents are cryptographically & structurally forbidden from casting approvals!
   */
  public decideGate(
    tenantId: string,
    params: {
      actor: string;
      taskId: string;
      headSha?: string;
      decision: "approve" | "reject";
      comment?: string;
      autoShip?: boolean;
    },
  ): { task: TaskRecord; approval: ApprovalRecord; gateSatisfied: boolean } {
    const tId = this.store.assertTenant(tenantId);
    let staged: string | null = null;
    const result = this.store.tx(() => {
      const humanWithKey = this.getPrincipalWithSecret(tId, params.actor);
      if (!humanWithKey) {
        throw new ForbiddenError(`unknown principal "${params.actor}"`);
      }
      if (humanWithKey.kind !== "human") {
        throw new ForbiddenError(
          `agents cannot approve or reject gates (actor "${params.actor}" is an agent)`,
        );
      }

      const task = this.getTask(tId, params.taskId);

      // The approver must hold channel access for the task's channel (grant_rule),
      // and protected security/ two_of_three gates additionally require an
      // elevated role — a `member` can never satisfy a security gate.
      this.requireChannelAccess(tId, params.actor, task.channel, "post");
      if (gatePolicyForTask(task) === "two_of_three" &&
          !["owner", "lead", "security"].includes(humanWithKey.role)) {
        throw new ForbiddenError(
          `gate on ${task.protectedPath ?? task.channel} requires role owner|lead|security (actor "${params.actor}" has role ${humanWithKey.role})`,
        );
      }
      if (!task.headSha) {
        throw new ConflictError(`task #${task.id} has no head SHA to approve`);
      }
      const targetSha = params.headSha ?? task.headSha;
      if (targetSha !== task.headSha) {
        throw new ConflictError(
          `approval SHA "${targetSha}" does not match current task head SHA "${task.headSha}"`,
        );
      }
      if (task.state !== "awaiting_approval") {
        throw new ConflictError(
          `task #${task.id} is in state "${task.state}", not awaiting_approval`,
        );
      }

      const now = this.now();
      const appId = `app_${task.id}_${crypto.randomBytes(3).toString("hex")}`;
      const sig = signEd25519(
        humanWithKey.privkey,
        canonicalJson({
          domain: "hive.approval.v1",
          tenantId: tId,
          taskId: task.id,
          headSha: targetSha,
          approver: params.actor,
          decision: params.decision,
        }),
      );

      this.store.db
        .prepare(
          `INSERT INTO approval
           (id, tenant_id, task_id, head_sha, approver, role, decision, comment, sig, invalidated_at, invalidated_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          appId,
          tId,
          task.id,
          targetSha,
          params.actor,
          humanWithKey.role,
          params.decision,
          params.comment ?? null,
          sig,
          now,
        );

      const approval: ApprovalRecord = {
        id: appId,
        tenantId: tId,
        taskId: task.id,
        headSha: targetSha,
        approver: params.actor,
        role: humanWithKey.role,
        decision: params.decision,
        comment: params.comment ?? null,
        sig,
        invalidatedAt: null,
        invalidatedReason: null,
        createdAt: now,
      };

      if (params.decision === "reject") {
        // A reject invalidates all outstanding approvals for THIS head SHA so a
        // later /ship cannot resurrect a gate the human already refused.
        this.store.db
          .prepare(
            `UPDATE approval
             SET invalidated_at = ?, invalidated_reason = 'gate_rejected'
             WHERE tenant_id = ? AND task_id = ? AND head_sha = ? AND decision = 'approve' AND invalidated_at IS NULL`,
          )
          .run(now, tId, task.id, targetSha);

        this.store.db
          .prepare(
            `UPDATE task SET state = 'reopened', revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(now, tId, task.id);

        this.appendEvent(tId, {
          kind: "gate.rejected",
          actor: params.actor,
          channel: task.channel,
          taskId: task.id,
          payload: { headSha: targetSha, comment: params.comment ?? "Changes requested" },
        });

        // Transition reopened -> ready so worker can pick up feedback
        this.store.db
          .prepare(
            `UPDATE task SET state = 'ready', owner = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(now, tId, task.id);

        if (task.owner) {
          this.enqueueWake(tId, {
            principal: task.owner,
            taskId: task.id,
            channel: task.channel,
            reason: `gate_rejected_by_${params.actor}: ${params.comment ?? "changes requested"}`,
          });
        }

        return { task: this.getTask(tId, task.id), approval, gateSatisfied: false };
      }

      this.appendEvent(tId, {
        kind: "gate.approved",
        actor: params.actor,
        channel: task.channel,
        taskId: task.id,
        payload: { headSha: targetSha, approvalId: appId, role: humanWithKey.role },
      });

      const satisfied = this.isMergeAllowed(tId, task.id).allowed;
      if (satisfied && params.autoShip !== false) {
        this.completeMergeAndVerifiedClose(tId, task.id, params.actor);
        staged = task.id;
      }

      return { task: this.getTask(tId, task.id), approval, gateSatisfied: satisfied };
    });
    if (staged) this.finalizeVerifiedClose(tId, staged, params.actor);
    return {
      task: this.getTask(tId, params.taskId),
      approval: result.approval,
      gateSatisfied: result.gateSatisfied,
    };
  }

  public isMergeAllowed(
    tenantId: string,
    taskId: string,
  ): { allowed: boolean; reason: string } {
    const tId = this.store.assertTenant(tenantId);
    const task = this.getTask(tId, taskId);
    const gate = gatePolicyForTask(task);
    const stateOk =
      task.state === "awaiting_approval" ||
      (task.state === "verifying" && gate === "none");
    if (!stateOk) {
      return {
        allowed: false,
        reason: `task #${task.id} is in state "${task.state}"; merge is only allowed from 'awaiting_approval' (gate satisfied) or 'verifying' (no gate)`,
      };
    }
    if (!task.headSha) {
      return { allowed: false, reason: "no head_sha recorded on task" };
    }

    // Must have a passing non-author clean-sandbox evidence receipt for THIS exact head_sha!
    const validEvidence = this.listEvidence(tId, task.id).filter(
      (ev) => ev.passed && ev.headSha === task.headSha && ev.producedBy !== task.owner,
    );
    if (validEvidence.length === 0) {
      return {
        allowed: false,
        reason: `missing passing independent verification receipt for head SHA ${task.headSha}`,
      };
    }

    const need = gatePolicyForTask(task);
    if (need === "none") {
      return { allowed: true, reason: "verified + no gate policy required" };
    }

    const validApprovals = this.listApprovals(tId, task.id).filter(
      (a) =>
        a.decision === "approve" &&
        a.invalidatedAt === null &&
        a.headSha === task.headSha,
    );

    const distinctHumans = new Set<string>();
    for (const a of validApprovals) {
      const p = this.getPrincipal(tId, a.approver);
      if (p && p.kind === "human") {
        const preimage = canonicalJson({
          domain: "hive.approval.v1",
          tenantId: tId,
          taskId: task.id,
          headSha: a.headSha,
          approver: a.approver,
          decision: "approve",
        });
        if (verifyEd25519(p.pubkey, preimage, a.sig)) {
          distinctHumans.add(a.approver);
        }
      }
    }

    const requiredCount = need === "two_of_three" ? 2 : 1;
    if (distinctHumans.size < requiredCount) {
      return {
        allowed: false,
        reason: `gate "${need}" requires ${requiredCount} valid human approval(s) on SHA ${task.headSha} (have ${distinctHumans.size})`,
      };
    }

    return {
      allowed: true,
      reason: `verified + ${distinctHumans.size}/${requiredCount} SHA-bound human approval(s) satisfied`,
    };
  }

  public shipTask(tenantId: string, actorId: string, taskId: string): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    this.store.tx(() => {
      this.requirePrincipal(tId, actorId);
      const check = this.isMergeAllowed(tId, taskId);
      if (!check.allowed) {
        throw new ForbiddenError(`merge refused by kernel gate: ${check.reason}`);
      }
      this.completeMergeAndVerifiedClose(tId, taskId, actorId);
    });
    this.finalizeVerifiedClose(tId, taskId, actorId);
    return this.getTask(tId, taskId);
  }

  private completeMergeAndVerifiedClose(
    tenantId: string,
    taskId: string,
    _actorId: string,
  ): void {
    const tId = this.store.assertTenant(tenantId);
    const task = this.getTask(tId, taskId);
    const check = this.isMergeAllowed(tId, taskId);
    if (!check.allowed) {
      throw new ForbiddenError(`cannot merge/close task #${taskId}: ${check.reason}`);
    }

    // 1. Stage the merge outbox row ONLY (network I/O happens post-commit in
    //    finalizeVerifiedClose). Resolve prNumber from the confirmed open-pr receipt
    //    so live GitHub merge actually works.
    let prNumber: number | null = null;
    try {
      const prRow = this.store.db
        .prepare(
          `SELECT receipt_json FROM outbox
           WHERE tenant_id = ? AND task_id = ? AND effect = 'open-pr' AND status = 'confirmed'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(tId, task.id) as { receipt_json: string | null } | undefined;
      if (prRow?.receipt_json) {
        const receipt = JSON.parse(prRow.receipt_json) as Record<string, unknown>;
        const n = Number(receipt.prNumber ?? 0);
        if (n > 0) prNumber = n;
      }
    } catch {
      prNumber = null;
    }
    this.stageOutboxEffect(
      tId,
      `task:${task.id}/sha:${task.headSha}/merge`,
      task.id,
      task.leaseEpoch,
      "merge",
      {
        taskId: task.id,
        headSha: task.headSha,
        repo: process.env.HIVE_GITHUB_REPO?.trim() || "acme/www",
        branch: task.branchRoom?.replace(/^branch\//, "") ?? `fix/task-${task.id}`,
        ...(prNumber ? { prNumber } : {}),
      },
    );
  }

  /**
   * Drain the staged merge effect (network I/O, no transaction held), then CAS the
   * task merged→closed with a VerifiedClose receipt. On drain failure the task is
   * left pre-close with a `task.effect_failed` event; approvals and evidence stay
   * committed, and `/ship` re-attempts with the same idempotency key.
   */
  public finalizeVerifiedClose(tenantId: string, taskId: string, actorId: string): TaskRecord {
    const tId = this.store.assertTenant(tenantId);
    const task = this.getTask(tId, taskId);
    if (task.state === "closed") return task; // finalize is idempotent
    const key = `task:${task.id}/sha:${task.headSha}/merge`;
    let mergeReceipt: Record<string, unknown>;
    try {
      mergeReceipt = this.drainOutboxEffect(tId, key, actorId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendEvent(tId, {
        kind: "task.effect_failed",
        actor: actorId,
        channel: task.channel,
        taskId: task.id,
        payload: { effect: "merge", error: msg, idempotencyKey: key },
      });
      return this.getTask(tId, taskId);
    }

    const now = this.now();
    return this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE task SET state = 'merged', revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(now, tId, task.id);

      this.appendEvent(tId, {
        kind: "task.merged",
        actor: actorId,
        channel: task.channel,
        taskId: task.id,
        payload: { headSha: task.headSha, mergeReceipt },
      });

        // Final CAS write: VerifiedClose receipt + audit checkpoint
      const evHashes = this.listEvidence(tId, task.id)
      .filter((e) => e.passed && e.headSha === task.headSha)
      .map((e) => e.receiptHash);
      const appSigs = this.listApprovals(tId, task.id)
      .filter((a) => a.decision === "approve" && !a.invalidatedAt && a.headSha === task.headSha)
      .map((a) => a.sig);

    const verifiedClose =
      "vc_" +
      sha256(
        canonicalJson({
          taskId: task.id,
          headSha: task.headSha,
          evidenceHashes: evHashes,
          approvalSigs: appSigs,
          leaseEpoch: task.leaseEpoch,
        }),
      ).slice(0, 20);

    const cur = this.getTask(tenantId, task.id);
    const closeRes = this.store.db
      .prepare(
        `UPDATE task
         SET state = 'closed', verified_close = ?, lease_until = NULL, revision = revision + 1, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND revision = ? AND state = 'merged'`,
      )
      .run(verifiedClose, now, tId, task.id, cur.revision);
    if (closeRes.changes !== 1) {
      throw new ConflictError("CAS conflict finalizing VerifiedClose");
    }

    this.appendEvent(tenantId, {
      kind: "task.closed",
      actor: "hive-kernel",
      channel: task.channel,
      taskId: task.id,
      payload: {
        taskId: task.id,
        headSha: task.headSha,
        verifiedClose,
        leaseEpoch: task.leaseEpoch,
      },
    });

      this.createCheckpoint(tId);

      // 3. Unblock any dependent tasks whose dependencies are now ALL closed with VerifiedClose!
      this.unblockDependents(tId, task.id);
      return this.getTask(tId, taskId);
    });
  }

  /**
   * Boot-time outbox reconcile (H2/H4 durability). Re-drives effects that were
   * staged or marked sent but never confirmed (e.g. process crashed between the
   * provider call and the confirm write), and closes tasks whose merge effect is
   * confirmed but whose merged→closed CAS never ran. Idempotent — a clean boot
   * does zero work.
   */
  public reconcileOutbox(tenantId: string): {
    drained: number;
    closed: number;
    failed: number;
  } {
    const tId = this.store.assertTenant(tenantId);
    const stash = this.store.db
      .prepare(
        `SELECT idempotency_key FROM outbox
         WHERE tenant_id = ? AND status IN ('pending', 'sent')
         ORDER BY created_at ASC`,
      )
      .all(tId) as { idempotency_key: string }[];
    let drained = 0;
    let failed = 0;
    for (const row of stash) {
      try {
        this.drainOutboxEffect(tId, row.idempotency_key, "hive-kernel");
        drained++;
      } catch (err) {
        failed++;
        this.appendEvent(tId, {
          kind: "outbox.reconcile_failed",
          actor: "hive-kernel",
          channel: null,
          taskId: null,
          payload: {
            idempotencyKey: row.idempotency_key,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    const stuck = this.store.db
      .prepare(
        `SELECT id, head_sha AS headSha FROM task
         WHERE tenant_id = ? AND state IN ('awaiting_approval', 'verifying', 'merged')
           AND head_sha IS NOT NULL`,
      )
      .all(tId) as { id: string; headSha: string }[];
    let closed = 0;
    for (const t of stuck) {
      const mergeKey = `task:${t.id}/sha:${t.headSha}/merge`;
      const confirmed = this.store.db
        .prepare(
          `SELECT 1 AS ok FROM outbox
           WHERE tenant_id = ? AND idempotency_key = ? AND status = 'confirmed'`,
        )
        .get(tId, mergeKey) as { ok: number } | undefined;
      if (!confirmed) continue;
      try {
        this.finalizeVerifiedClose(tId, t.id, "hive-kernel");
        closed++;
      } catch (err) {
        this.appendEvent(tId, {
          kind: "outbox.reconcile_close_failed",
          actor: "hive-kernel",
          channel: null,
          taskId: t.id,
          payload: {
            taskId: t.id,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    return { drained, closed, failed };
  }

  private unblockDependents(tenantId: string, closedTaskId: string) {
    const depRows = this.store.db
      .prepare("SELECT task_id FROM task_dep WHERE tenant_id = ? AND dep_id = ?")
      .all(tenantId, closedTaskId) as { task_id: string }[];

    for (const r of depRows) {
      const candidate = this.getTask(tenantId, r.task_id);
      if (candidate.state !== "blocked") continue;
      const allClosed = candidate.deps.every((d) => {
        const dt = this.getTask(tenantId, d);
        return dt.state === "closed" && Boolean(dt.verifiedClose);
      });
      if (allClosed) {
        const now = this.now();
        this.store.db
          .prepare(
            `UPDATE task SET state = 'ready', revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND state = 'blocked'`,
          )
          .run(now, tenantId, candidate.id);
        this.appendEvent(tenantId, {
          kind: "task.unblocked",
          actor: "hive-kernel",
          channel: candidate.channel,
          taskId: candidate.id,
          payload: { satisfiedDeps: candidate.deps },
        });
        this.enqueueEligibleWorkerWake(
          tenantId,
          candidate.id,
          candidate.channel,
          `deps_closed:${candidate.deps.join(",")}`,
        );
      }
    }
  }

  /* ========================================================================
   *  ALGORITHM 6 · FENCED IDEMPOTENT OUTBOX
   * ====================================================================== */

  public runEffect(
    tenantId: string,
    params: {
      key: string;
      effect: EffectKind;
      args: Record<string, unknown>;
      taskId?: string;
      token?: string;
      actor?: string;
    },
  ): Record<string, unknown> {
    const tId = this.store.assertTenant(tenantId);
    let actor = params.actor ?? "system";
    let leaseEpoch: number | null = null;
    const taskId =
      params.taskId ?? (params.args.taskId ? String(params.args.taskId) : undefined);

    if (params.token) {
      if (taskId) {
        const { task, claims } = this.guardedTask(
          tId,
          params.token,
          taskId,
          `effect:${params.effect}`,
        );
        actor = claims.sub;
        leaseEpoch = task.leaseEpoch;
      } else {
        const claims = this.verifyCap(tId, params.token, `effect:${params.effect}`);
        actor = claims.sub;
      }
    } else if (params.actor) {
      const caller = this.getPrincipal(tId, params.actor);
      if (caller?.kind === "agent") {
        throw new ForbiddenError(
          `agent "${params.actor}" must present a lease-scoped hct_ capability token to fire effects`,
        );
      }
      this.authorizePrincipal(tId, params.actor, `effect:${params.effect}`);
    } else {
      throw new ForbiddenError("runEffect requires a lease-scoped hct_ token or an authenticated actor");
    }

    if (params.effect === "merge") {
      if (!taskId) throw new ValidationError("merge effect requires taskId");
      const check = this.isMergeAllowed(tId, taskId);
      if (!check.allowed) {
        throw new ForbiddenError(`outbox refused merge: ${check.reason}`);
      }
    }

    this.stageOutboxEffect(tId, params.key, taskId ?? null, leaseEpoch, params.effect, params.args);
    return this.drainOutboxEffect(tId, params.key, actor);
  }

  private stageOutboxEffect(
    tenantId: string,
    key: string,
    taskId: string | null,
    leaseEpoch: number | null,
    effect: EffectKind,
    args: Record<string, unknown>,
  ): void {
    const now = this.now();
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO outbox
         (idempotency_key, tenant_id, task_id, lease_epoch, effect, args_json, status, receipt_json, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, ?, ?)`,
      )
      .run(key, tenantId, taskId, leaseEpoch, effect, canonicalJson(args), now, now);
  }

  private markOutboxFailed(tenantId: string, key: string, msg: string): void {
    const now = this.now();
    this.store.db
      .prepare(
        `UPDATE outbox SET status = 'failed', last_error = ?, locked_by = NULL, locked_until = NULL, updated_at = ?
         WHERE tenant_id = ? AND idempotency_key = ?`,
      )
      .run(msg, now, tenantId, key);
  }

  /**
   * Drain one staged outbox effect: outbound DLP check first, then read-after-write
   * reconciliation (findExisting) and perform. Runs OUTSIDE any transaction.
   * Marks the row 'failed' and throws on error.
   */
  private drainOutboxEffect(
    tenantId: string,
    key: string,
    actor: string,
  ): Record<string, unknown> {
    const tId = this.store.assertTenant(tenantId);
    const row = this.store.db
      .prepare("SELECT * FROM outbox WHERE tenant_id = ? AND idempotency_key = ?")
      .get(tId, key) as
      | {
          effect: EffectKind;
          args_json: string;
          status: string;
          receipt_json: string | null;
          task_id: string | null;
        }
      | undefined;
    if (!row) throw new ValidationError(`outbox key "${key}" was not staged`);
    const effect = row.effect;
    const taskId = row.task_id;
    const args = JSON.parse(row.args_json) as Record<string, unknown>;

    // Outbound DLP runs post-commit, pre-send: a blocked payload marks the row
    // 'failed' with the reason and never reaches the provider.
    try {
      enforceOutboundDlp(canonicalJson(args));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markOutboxFailed(tId, key, msg);
      throw err;
    }

    if (row.status === "confirmed" && row.receipt_json) {
      return JSON.parse(row.receipt_json) as Record<string, unknown>;
    }

    // Atomic claim — the ONLY entry into provider I/O. Inline drains (runEffect) and
    // the background outbox worker fence on the same row update, so an effect is
    // performed at most once per claim window (SKIP-LOCKED semantics; on Postgres
    // this becomes SELECT … FOR UPDATE SKIP LOCKED).
    // Retryable failures (provider/network) are claimable again; terminal failures
    // (DLP blocks, max-attempts) are never re-claimed.
    const now = this.now();
    const lockUntil = now + OUTBOX_LOCK_MS;
    const claim = this.store.db
      .prepare(
        `UPDATE outbox
           SET status = 'sent',
               attempts = attempts + 1,
               locked_by = ?,
               locked_until = ?,
               updated_at = ?
         WHERE tenant_id = ? AND idempotency_key = ?
           AND (locked_until IS NULL OR locked_until <= ?)
           AND (
             status IN ('pending', 'sent')
             OR (
               status = 'failed'
               AND COALESCE(last_error, '') NOT LIKE 'DLP blocked%'
               AND COALESCE(last_error, '') <> 'max attempts exceeded'
             )
           )`,
      )
      .run(this.instanceId, lockUntil, now, tId, key, now);
    if (Number(claim.changes) === 0) {
      const fresh = this.store.db
        .prepare(
          "SELECT status, receipt_json FROM outbox WHERE tenant_id = ? AND idempotency_key = ?",
        )
        .get(tId, key) as { status: string; receipt_json: string | null } | undefined;
      if (fresh?.status === "confirmed" && fresh.receipt_json) {
        return JSON.parse(fresh.receipt_json) as Record<string, unknown>;
      }
      throw new ConflictError(
        `effect "${key}" is being drained by another worker or already delivered (status=${fresh?.status ?? "unknown"})`,
      );
    }

    try {
      // Read-after-write check first so retries after network drops never duplicate!
      const reconciled = this.connectors.findExisting(tId, effect, args, key);
      const receipt =
        reconciled ?? this.connectors.perform(tId, effect, args, key);

      this.store.db
        .prepare(
          `UPDATE outbox
           SET status = 'confirmed', receipt_json = ?, last_error = NULL,
               locked_by = NULL, locked_until = NULL, updated_at = ?
           WHERE tenant_id = ? AND idempotency_key = ?`,
        )
        .run(canonicalJson(receipt), now, tId, key);

      this.appendEvent(tId, {
        kind: `effect.${effect}`,
        actor,
        channel: taskId ? this.findTask(tId, taskId)?.channel ?? null : null,
        taskId,
        payload: { idempotencyKey: key, receipt },
      });

      if (effect === "open-pr" && taskId && typeof receipt.headSha === "string") {
        this.store.db
          .prepare(
            "UPDATE task SET head_sha = COALESCE(head_sha, ?) WHERE tenant_id = ? AND id = ?",
          )
          .run(String(receipt.headSha), tId, taskId);
      }

      return receipt;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markOutboxFailed(tId, key, msg);
      throw err;
    }
  }

  public listOutbox(tenantId: string): OutboxRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM outbox WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tId) as {
      idempotency_key: string;
      tenant_id: string;
      task_id: string | null;
      lease_epoch: number | null;
      effect: EffectKind;
      args_json: string;
      status: OutboxRecord["status"];
      receipt_json: string | null;
      attempts: number;
      last_error: string | null;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      tenantId: r.tenant_id,
      taskId: r.task_id,
      leaseEpoch: r.lease_epoch === null ? null : Number(r.lease_epoch),
      effect: r.effect,
      args: JSON.parse(r.args_json) as Record<string, unknown>,
      status: r.status,
      receipt: r.receipt_json
        ? (JSON.parse(r.receipt_json) as Record<string, unknown>)
        : null,
      attempts: Number(r.attempts),
      lastError: r.last_error,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  /* ========================================================================
   *  ALGORITHM 5 · WAKE QUEUE, SCHEDULER, HEARTBEAT EXPIRY & WORKING-SET DIFF
   * ====================================================================== */

  public enqueueWake(
    tenantId: string,
    params: {
      principal: string;
      taskId?: string | null;
      channel?: string | null;
      reason: string;
      inMs?: number;
      noSync?: boolean;
    },
  ): WakeRecord {
    const tId = this.store.assertTenant(tenantId);
    const dueAt = this.now() + (params.inMs ?? 0);
    const info = this.store.db
      .prepare(
        `INSERT INTO wake_queue (tenant_id, principal, task_id, channel, reason, no_sync, due_at, delivered_at, delivery_attempts, ack_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
      )
      .run(
        tId,
        params.principal,
        params.taskId ?? null,
        params.channel ?? null,
        params.reason,
        params.noSync ? 1 : 0,
        dueAt,
      );
    const id = Number(info.lastInsertRowid);
    return {
      id,
      tenantId: tId,
      principal: params.principal,
      taskId: params.taskId ?? null,
      channel: params.channel ?? null,
      reason: params.reason,
      noSync: Boolean(params.noSync),
      dueAt,
      deliveredAt: null,
      deliveryAttempts: 0,
      ackAt: null,
    };
  }

  public listWakes(tenantId: string): WakeRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM wake_queue WHERE tenant_id = ? ORDER BY id DESC LIMIT 100")
      .all(tId) as {
      id: number;
      tenant_id: string;
      principal: string;
      task_id: string | null;
      channel: string | null;
      reason: string;
      no_sync: number;
      due_at: number;
      delivered_at: number | null;
      delivery_attempts: number;
      ack_at: number | null;
    }[];
    return rows.map((r) => ({
      id: Number(r.id),
      tenantId: r.tenant_id,
      principal: r.principal,
      taskId: r.task_id,
      channel: r.channel,
      reason: r.reason,
      noSync: Boolean(r.no_sync),
      dueAt: Number(r.due_at),
      deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
      deliveryAttempts: Number(r.delivery_attempts),
      ackAt: r.ack_at === null ? null : Number(r.ack_at),
    }));
  }

  /**
   * Advances optional simulated clock, expires missed-heartbeat leases
   * (`claimed -> expired -> ready`, preserving `lease_epoch` so next claim fences the zombie!),
   * and delivers due wake items with compressed working-set diffs.
   */
  public schedulerTick(
    tenantId: string,
    opts?: { advanceMs?: number; dropDeliveryOnce?: boolean },
  ): {
    expiredTasks: string[];
    deliveries: WorkingSetDelivery[];
  } {
    const tId = this.store.assertTenant(tenantId);
    if (opts?.advanceMs && opts.advanceMs > 0) {
      this.store.advanceClock(opts.advanceMs);
    }

    return this.store.tx(() => {
      const now = this.now();
      const expiredTasks: string[] = [];

      // 1. Sweep missed-heartbeat leases
      const stale = this.listTasks(tId).filter(
        (t) => t.state === "claimed" && t.leaseUntil !== null && t.leaseUntil <= now,
      );
      for (const t of stale) {
        this.store.db
          .prepare(
            `UPDATE task SET state = 'expired', revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND state = 'claimed'`,
          )
          .run(now, tId, t.id);
        this.appendEvent(tId, {
          kind: "task.lease_expired",
          actor: "hive-scheduler",
          channel: t.channel,
          taskId: t.id,
          payload: { previousOwner: t.owner, fencedEpoch: t.leaseEpoch },
        });
        // Re-queue expired -> ready; lease_epoch stays at N so next claim bumps to N+1!
        this.store.db
          .prepare(
            `UPDATE task
             SET state = 'ready', owner = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND state = 'expired'`,
          )
          .run(now, tId, t.id);
        expiredTasks.push(t.id);
      }

      // 2. Deliver due wakes that have not been acknowledged yet (handles lost-wake redelivery!)
      const dueRows = this.store.db
        .prepare(
          `SELECT * FROM wake_queue
           WHERE tenant_id = ? AND due_at <= ? AND ack_at IS NULL
           ORDER BY due_at ASC, id ASC`,
        )
        .all(tId, now) as {
        id: number;
        principal: string;
        task_id: string | null;
        channel: string | null;
        reason: string;
      }[];

      const deliveries: WorkingSetDelivery[] = [];
      for (const w of dueRows) {
        this.store.db
          .prepare(
            `UPDATE wake_queue
             SET delivered_at = ?, delivery_attempts = delivery_attempts + 1
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(now, tId, w.id);

        if (opts?.dropDeliveryOnce && deliveries.length === 0) {
          // Simulated lost packet before worker receives/acks wake!
          continue;
        }

        const diff = this.readInboxSinceCursor(tId, w.principal, {
          scope: w.task_id ? `task:${w.task_id}` : `channel:${w.channel ?? "all"}`,
          taskId: w.task_id ?? undefined,
          channel: w.channel ?? undefined,
          advanceCursor: false,
        });

        deliveries.push({
          wakeId: Number(w.id),
          principal: w.principal,
          taskId: w.task_id,
          reason: w.reason,
          cursorFrom: diff.cursorFrom,
          cursorTo: diff.cursorTo,
          totalEventsInLog: diff.totalEventsInLog,
          diffEvents: diff.events,
          compressionRatioPct: diff.compressionRatioPct,
        });
      }

      return { expiredTasks, deliveries };
    });
  }

  /**
   * Worker acknowledges wake receipt -> advances read_cursor idempotently.
   */
  public ackWake(tenantId: string, wakeId: number): WorkingSetDelivery {
    const tId = this.store.assertTenant(tenantId);
    return this.store.tx(() => {
      const w = this.listWakes(tId).find((x) => x.id === wakeId);
      if (!w) throw new ValidationError(`no such wake ${wakeId}`);
      const scope = w.taskId ? `task:${w.taskId}` : `channel:${w.channel ?? "all"}`;
      const diff = this.readInboxSinceCursor(tId, w.principal, {
        scope,
        taskId: w.taskId ?? undefined,
        channel: w.channel ?? undefined,
        advanceCursor: true,
      });
      if (!w.ackAt) {
        this.store.db
          .prepare("UPDATE wake_queue SET ack_at = ? WHERE tenant_id = ? AND id = ?")
          .run(this.now(), tId, wakeId);
      }
      return {
        wakeId: w.id,
        principal: w.principal,
        taskId: w.taskId,
        reason: w.reason,
        cursorFrom: diff.cursorFrom,
        cursorTo: diff.cursorTo,
        totalEventsInLog: diff.totalEventsInLog,
        diffEvents: diff.events,
        compressionRatioPct: diff.compressionRatioPct,
      };
    });
  }

  public readInboxSinceCursor(
    tenantId: string,
    principalId: string,
    opts?: {
      scope?: string;
      taskId?: string;
      channel?: string;
      advanceCursor?: boolean;
      maxEvents?: number;
    },
  ): {
    cursorFrom: number;
    cursorTo: number;
    totalEventsInLog: number;
    events: EventRecord[];
    compressionRatioPct: number;
  } {
    const tId = this.store.assertTenant(tenantId);
    const scope =
      opts?.scope ??
      (opts?.taskId ? `task:${opts.taskId}` : `channel:${opts?.channel ?? "all"}`);
    const meta = this.store.getMeta();

    const curRow = this.store.db
      .prepare(
        "SELECT last_seq, incarnation FROM read_cursor WHERE tenant_id = ? AND principal = ? AND scope = ?",
      )
      .get(tId, principalId, scope) as
      | { last_seq: number; incarnation: string }
      | undefined;

    // If DB incarnation changed (PITR restore), reset cursor safely to 0
    const cursorFrom =
      curRow && curRow.incarnation === meta.incarnation ? Number(curRow.last_seq) : 0;

    const allTenantEvents = this.listEvents(tId, { limit: 10000 });
    const filtered = this.listEvents(tId, {
      taskId: opts?.taskId,
      channel: opts?.taskId ? undefined : opts?.channel,
      sinceSeq: cursorFrom,
      limit: opts?.maxEvents ?? 25,
    });

    const cursorTo = filtered.length
      ? filtered[filtered.length - 1].seq
      : cursorFrom;

    if (opts?.advanceCursor !== false && cursorTo > cursorFrom) {
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO read_cursor (tenant_id, principal, scope, last_seq, incarnation, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(tId, principalId, scope, cursorTo, meta.incarnation, this.now());
    }

    const total = Math.max(1, allTenantEvents.length);
    const ratio = Math.round((filtered.length / total) * 100);
    return {
      cursorFrom,
      cursorTo,
      totalEventsInLog: allTenantEvents.length,
      events: filtered,
      compressionRatioPct: ratio,
    };
  }

  /* ========================================================================
   *  DETERMINISTIC REGISTERED /COMMANDS EXECUTION
   * ====================================================================== */

  public executeSlashCommand(
    tenantId: string,
    actorId: string,
    line: string,
  ): { verb: string; summary: string; task: TaskRecord } {
    const tId = this.store.assertTenant(tenantId);
    const parsed = parseSlashCommand(line);
    switch (parsed.verb) {
      case "triage": {
        return this.store.tx(() => {
          this.authorizePrincipal(tId, actorId, "task.triage");
          const task = this.getTask(tId, parsed.taskId);
          const labels = {
            ...task.labels,
            severity: parsed.severity,
            area: parsed.area,
            ...(parsed.assignHint ? { suggestedOwner: parsed.assignHint } : {}),
          };
          this.store.db
            .prepare(
              "UPDATE task SET labels_json = ?, revision = revision + 1, updated_at = ? WHERE tenant_id = ? AND id = ?",
            )
            .run(JSON.stringify(labels), this.now(), tId, task.id);
          this.appendEvent(tId, {
            kind: "command.triage",
            actor: actorId,
            channel: task.channel,
            taskId: task.id,
            payload: { severity: parsed.severity, area: parsed.area, assignHint: parsed.assignHint },
          });
          return {
            verb: "triage",
            summary: `triaged #${task.id} (${parsed.severity}, area=${parsed.area})`,
            task: this.getTask(tId, task.id),
          };
        });
      }
      case "approve": {
        const res = this.decideGate(tId, {
          actor: actorId,
          taskId: parsed.taskId,
          headSha: parsed.sha,
          decision: "approve",
          comment: parsed.comment,
        });
        return {
          verb: "approve",
          summary: res.gateSatisfied
            ? `approved #${res.task.id} @ ${res.approval.headSha} → gate satisfied, merged & VerifiedClose (${res.task.verifiedClose})`
            : `approved #${res.task.id} @ ${res.approval.headSha} (awaiting remaining quorum)`,
          task: res.task,
        };
      }
      case "reject": {
        const res = this.decideGate(tId, {
          actor: actorId,
          taskId: parsed.taskId,
          decision: "reject",
          comment: parsed.comment,
        });
        return {
          verb: "reject",
          summary: `rejected #${res.task.id} — merge stays blocked, re-queued with feedback`,
          task: res.task,
        };
      }
      case "resume": {
        const task = this.resumeHaltedTask(tId, {
          actor: actorId,
          taskId: parsed.taskId,
          newCapCents: Math.round(parsed.capDollars * 100),
          hint: parsed.hint,
        });
        return {
          verb: "resume",
          summary: `resumed #${task.id} with cap $${parsed.capDollars.toFixed(2)}`,
          task,
        };
      }
      case "ship": {
        const task = this.shipTask(tId, actorId, parsed.taskId);
        return {
          verb: "ship",
          summary: `shipped #${task.id} → VerifiedClose ${task.verifiedClose}`,
          task,
        };
      }
    }
  }

  /* ========================================================================
   *  READ HELPERS
   * ====================================================================== */

  public findTask(tenantId: string, taskId: string): TaskRecord | undefined {
    const tId = this.store.assertTenant(tenantId);
    const row = this.store.db
      .prepare("SELECT * FROM task WHERE tenant_id = ? AND id = ?")
      .get(tId, taskId) as Parameters<typeof this.mapTaskRow>[0] | undefined;
    return row ? this.mapTaskRow(row) : undefined;
  }

  public getTask(tenantId: string, taskId: string): TaskRecord {
    const t = this.findTask(tenantId, taskId);
    if (!t) throw new ValidationError(`no such task #${taskId} in tenant "${tenantId}"`);
    return t;
  }

  public listTasks(tenantId: string): TaskRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare("SELECT * FROM task WHERE tenant_id = ? ORDER BY created_at ASC, id ASC")
      .all(tId) as Parameters<typeof this.mapTaskRow>[0][];
    return rows.map((r) => this.mapTaskRow(r));
  }

  private mapTaskRow(row: {
    id: string;
    tenant_id: string;
    goal_id: string | null;
    channel: string;
    branch_room: string | null;
    title: string;
    state: TaskState;
    owner: string | null;
    lease_epoch: number;
    lease_until: number | null;
    attempt: number;
    budget_cap_cents: number;
    budget_spent: number;
    revision: number;
    origin_operation_id: string;
    trust: Trust;
    head_sha: string | null;
    protected_path: string | null;
    gate_policy: GatePolicy;
    verified_close: string | null;
    labels_json: string;
    created_at: number;
    updated_at: number;
  }): TaskRecord {
    const depRows = this.store.db
      .prepare("SELECT dep_id FROM task_dep WHERE tenant_id = ? AND task_id = ? ORDER BY dep_id ASC")
      .all(row.tenant_id, row.id) as { dep_id: string }[];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      goalId: row.goal_id,
      channel: row.channel,
      branchRoom: row.branch_room,
      title: row.title,
      state: row.state,
      owner: row.owner,
      leaseEpoch: Number(row.lease_epoch),
      leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
      attempt: Number(row.attempt),
      budgetCapCents: Number(row.budget_cap_cents),
      budgetSpent: Number(row.budget_spent),
      revision: Number(row.revision),
      originOperationId: row.origin_operation_id,
      trust: row.trust,
      headSha: row.head_sha,
      protectedPath: row.protected_path,
      gatePolicy: row.gate_policy,
      verifiedClose: row.verified_close,
      labels: JSON.parse(row.labels_json) as Record<string, string>,
      deps: depRows.map((d) => d.dep_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  public listEvidence(tenantId: string, taskId?: string): EvidenceRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = (
      taskId
        ? this.store.db
            .prepare("SELECT * FROM evidence WHERE tenant_id = ? AND task_id = ? ORDER BY created_at ASC")
            .all(tId, taskId)
        : this.store.db
            .prepare("SELECT * FROM evidence WHERE tenant_id = ? ORDER BY created_at DESC")
            .all(tId)
    ) as {
      id: string;
      tenant_id: string;
      task_id: string;
      kind: string;
      head_sha: string;
      lease_epoch: number;
      result_json: string;
      passed: number;
      produced_by: string;
      sandbox_tree: string;
      receipt_hash: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      taskId: r.task_id,
      kind: r.kind,
      headSha: r.head_sha,
      leaseEpoch: Number(r.lease_epoch),
      result: JSON.parse(r.result_json) as Record<string, unknown>,
      passed: Boolean(r.passed),
      producedBy: r.produced_by,
      sandboxTree: r.sandbox_tree,
      receiptHash: r.receipt_hash,
      createdAt: Number(r.created_at),
    }));
  }

  public listApprovals(tenantId: string, taskId?: string): ApprovalRecord[] {
    const tId = this.store.assertTenant(tenantId);
    const rows = (
      taskId
        ? this.store.db
            .prepare("SELECT * FROM approval WHERE tenant_id = ? AND task_id = ? ORDER BY created_at ASC")
            .all(tId, taskId)
        : this.store.db
            .prepare("SELECT * FROM approval WHERE tenant_id = ? ORDER BY created_at DESC")
            .all(tId)
    ) as {
      id: string;
      tenant_id: string;
      task_id: string;
      head_sha: string;
      approver: string;
      role: string;
      decision: "approve" | "reject";
      comment: string | null;
      sig: string;
      invalidated_at: number | null;
      invalidated_reason: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      taskId: r.task_id,
      headSha: r.head_sha,
      approver: r.approver,
      role: r.role,
      decision: r.decision,
      comment: r.comment,
      sig: r.sig,
      invalidatedAt: r.invalidated_at === null ? null : Number(r.invalidated_at),
      invalidatedReason: r.invalidated_reason,
      createdAt: Number(r.created_at),
    }));
  }

  /* ========================================================================
   *  ASYNC OUTBOX WORKER (Phase 2) — claims fenced pending/stale-sent rows and drains them
   * ====================================================================== */

  /**
   * Process claimable outbox rows (pending, or stale 'sent' past lock expiry) for a tenant.
   * Called by the server's outbox worker loop and safe to call concurrently with inline
   * drains — the atomic claim inside drainOutboxEffect is the fence.
   */
  public processOutboxPending(
    tenantId: string,
    opts?: { limit?: number },
  ): { claimed: number; confirmed: number; failed: number } {
    const tId = this.store.assertTenant(tenantId);
    const limit = Math.max(1, Math.min(opts?.limit ?? 16, 64));
    const now = this.now();
    const maxAttempts = Number(process.env.HIVE_OUTBOX_MAX_ATTEMPTS ?? 8);

    // Poison rows: claimable but already exhausted → fail terminally, never call the provider.
    this.store.db
      .prepare(
        `UPDATE outbox
           SET status = 'failed', last_error = 'max attempts exceeded', updated_at = ?
         WHERE tenant_id = ? AND status IN ('pending', 'sent') AND attempts >= ?
           AND COALESCE(last_error, '') NOT LIKE 'DLP blocked%'
           AND (locked_until IS NULL OR locked_until <= ?)`,
      )
      .run(now, tId, maxAttempts, now);
    // Retryable failures that already exhausted their attempts become terminally marked too.
    this.store.db
      .prepare(
        `UPDATE outbox
           SET status = 'failed', last_error = 'max attempts exceeded', updated_at = ?
         WHERE tenant_id = ? AND status = 'failed' AND attempts >= ?
           AND COALESCE(last_error, '') NOT LIKE 'DLP blocked%'
           AND COALESCE(last_error, '') <> 'max attempts exceeded'`,
      )
      .run(now, tId, maxAttempts);

    const claimable = this.store.db
      .prepare(
        `SELECT idempotency_key, status, attempts, updated_at FROM outbox
         WHERE tenant_id = ?
           AND attempts < ?
           AND (locked_until IS NULL OR locked_until <= ?)
           AND (
             status IN ('pending', 'sent')
             OR (
               status = 'failed'
               AND COALESCE(last_error, '') NOT LIKE 'DLP blocked%'
               AND COALESCE(last_error, '') <> 'max attempts exceeded'
             )
           )
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(tId, maxAttempts, now, limit * 4) as {
        idempotency_key: string;
        status: string;
        attempts: number;
        updated_at: number;
      }[];

    // Exponential backoff for retryable failed rows (min(2^attempts, 60s)) — provider
    // outages must not hot-loop the worker. Pending/stale-sent rows drain immediately.
    const failedBackoffMs = (attempts: number) => Math.min(2 ** Math.max(0, attempts) * 1000, 60_000);
    const rows = claimable
      .filter((r) => r.status !== "failed" || r.updated_at + failedBackoffMs(r.attempts) <= now)
      .slice(0, limit);

    let confirmed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        this.drainOutboxEffect(tId, row.idempotency_key, "hive-outbox-worker");
        confirmed += 1;
      } catch {
        failed += 1; // drainOutboxEffect already marked the row failed with the reason
      }
    }
    return { claimed: rows.length, confirmed, failed };
  }

  /* ========================================================================
   *  EVIDENCE ARTIFACT STORE (Phase 2) — sha256-addressed, tenant-scoped, disk-backed
   * ====================================================================== */

  private artifactRoot(): string {
    return path.resolve(process.env.HIVE_ARTIFACT_DIR ?? path.join(".hive", "artifacts"));
  }

  /**
   * Persist an artifact under its sha256 (content-addressed, idempotent). Bytes are DLP-scanned
   * (best-effort on binary) and written with 0600 inside a 0700 tree. Cross-tenant reads are
   * refused at the HTTP layer via the artifact row; storage never mixes tenants on disk either
   * (file name is the content hash; the tenant index lives in SQLite).
   */
  public storeArtifact(
    tenantId: string,
    params: { actor: string; mediaType: string; bytes: Buffer; evidenceId?: string },
  ): { sha256: string; size: number; createdAt: number } {
    const tId = this.store.assertTenant(tenantId);
    const actor = this.getPrincipal(tId, params.actor);
    if (!actor) {
      throw new ForbiddenError(`unknown principal "${params.actor}" in tenant "${tId}"`);
    }
    enforceOutboundDlp(params.bytes.toString("utf8"));
    const sha256 = crypto.createHash("sha256").update(params.bytes).digest("hex");
    const root = this.artifactRoot();
    const dir = path.join(root, sha256.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, sha256);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, params.bytes, { mode: 0o600 });
    }
    const now = this.now();
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO artifact (tenant_id, sha256, size, media_type, created_by, evidence_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tId, sha256, params.bytes.length, params.mediaType, params.actor, params.evidenceId ?? null, now);
    this.appendEvent(tId, {
      kind: "artifact.stored",
      actor: params.actor,
      channel: null,
      taskId: null,
      payload: { sha256, size: params.bytes.length, mediaType: params.mediaType, evidenceId: params.evidenceId ?? null },
    });
    return { sha256, size: params.bytes.length, createdAt: now };
  }

  public getArtifact(
    tenantId: string,
    sha256: string,
  ): { sha256: string; size: number; mediaType: string; createdBy: string; createdAt: number; evidenceId: string | null } | null {
    const tId = this.store.assertTenant(tenantId);
    const row = this.store.db
      .prepare(
        "SELECT sha256, size, media_type, created_by, evidence_id, created_at FROM artifact WHERE tenant_id = ? AND sha256 = ?",
      )
      .get(tId, sha256) as
      | { sha256: string; size: number; media_type: string; created_by: string; evidence_id: string | null; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      sha256: row.sha256,
      size: Number(row.size),
      mediaType: row.media_type,
      createdBy: row.created_by,
      evidenceId: row.evidence_id,
      createdAt: Number(row.created_at),
    };
  }

  /** Read artifact bytes, re-verifying the content hash (detects disk tampering). */
  public readArtifactBytes(tenantId: string, sha256: string): Buffer {
    const row = this.getArtifact(tenantId, sha256);
    if (!row) throw new ValidationError(`artifact ${sha256} not found`);
    const file = path.join(this.artifactRoot(), sha256.slice(0, 2), sha256);
    const bytes = fs.readFileSync(file);
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) {
      throw new ArtifactCorruptError(`artifact ${sha256} failed integrity check (disk tampering suspected)`);
    }
    return bytes;
  }

  public listArtifacts(tenantId: string): Array<{ sha256: string; size: number; mediaType: string; createdBy: string; evidenceId: string | null; createdAt: number }> {
    const tId = this.store.assertTenant(tenantId);
    const rows = this.store.db
      .prepare(
        "SELECT sha256, size, media_type, created_by, evidence_id, created_at FROM artifact WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200",
      )
      .all(tId) as { sha256: string; size: number; media_type: string; created_by: string; evidence_id: string | null; created_at: number }[];
    return rows.map((r) => ({
      sha256: r.sha256,
      size: Number(r.size),
      mediaType: r.media_type,
      createdBy: r.created_by,
      evidenceId: r.evidence_id,
      createdAt: Number(r.created_at),
    }));
  }

  public snapshotWorkspace(tenantId: string) {
    const tId = this.store.assertTenant(tenantId);
    return {
      tenantId: tId,
      incarnation: this.getIncarnation(),
      now: this.now(),
      principals: this.listPrincipals(tId),
      grants: this.listGrants(tId),
      schemas: this.listSchemas(tId),
      channels: this.listChannelRooms(tId),
      tasks: this.listTasks(tId),
      events: this.listEvents(tId, { limit: 250 }),
      evidence: this.listEvidence(tId),
      approvals: this.listApprovals(tId),
      outbox: this.listOutbox(tId),
      wakes: this.listWakes(tId),
      checkpoints: this.listCheckpoints(tId),
      connectors: this.connectors.inspectTenantEffects(tId),
      logVerification: this.verifyLog(tId, "latest"),
    };
  }
}
