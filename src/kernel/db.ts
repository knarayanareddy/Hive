import fs from "node:fs";
import { CUSTODY_PURPOSES, decryptCustodial, encryptCustodial, isEncryptedCustodial, masterKeyFromEnv } from "./custody";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { generateEd25519KeyPair } from "./crypto";
import { ForbiddenError } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_PATH = path.resolve(__dirname, "../../db/migrations/001_sqlite.sql");
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, "utf8");

export interface AuthorityMeta {
  incarnation: string;
  gatewayPub: string;
  gatewayPriv: string;
  simNowMs: number;
  rotatedAt: number;
}

export class HiveStore {
  public db: DatabaseSync;
  public readonly filePath: string;
  private txDepth = 0;
  /** Post-commit callbacks (SSE fan-out etc.). Run once, after the OUTERMOST commit only — never on rollback. */
  private commitHooks: { depth: number; cb: () => void }[] = [];
  /**
   * Wall-clock virtual offset (ms). `hive tick --advance` fast-forwards the
   * kernel's perception of "now" without touching wall time; it is process-local
   * and resets to 0 on restart (leases then appear sooner, which fails safe).
   * Never used in HIVE_CLOCK_MODE=sim (frozen test clock) — there, advanceClock
   * persists sim_now_ms exactly as before.
   */
  private clockOffsetMs = 0;

  constructor(filePath = ":memory:") {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.initPragmasAndSchema();
  }

  private initPragmasAndSchema() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(MIGRATION_SQL);
    // Additive columns for the Phase 2 outbox fence (001_sqlite.sql already carries them
    // for fresh databases; ALTER keeps pre-Phase-2 databases working).
    const outboxCols = this.db
      .prepare("PRAGMA table_info(outbox)")
      .all() as { name: string }[];
    if (!outboxCols.some((c) => c.name === "locked_by")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN locked_by TEXT");
    }
    if (!outboxCols.some((c) => c.name === "locked_until")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN locked_until INTEGER");
    }

    const existing = this.db
      .prepare("SELECT incarnation FROM authority_meta WHERE singleton = 1")
      .get() as { incarnation: string } | undefined;

    if (!existing) {
      const kp = generateEd25519KeyPair();
      const now = 1795606800000; // 2026-11-25T09:00:00Z baseline
      const masterKey = masterKeyFromEnv();
      const storedPriv = masterKey
        ? encryptCustodial(kp.privateKey, masterKey, CUSTODY_PURPOSES.gateway)
        : kp.privateKey;
      this.db
        .prepare(
          `INSERT INTO authority_meta (singleton, incarnation, gateway_pub, gateway_priv, sim_now_ms, rotated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), kp.publicKey, storedPriv, now, now);
    } else {
      this.encryptLegacyCustodialRows();
    }
  }

  /**
   * One-time sweep: when HIVE_MASTER_KEY is configured, re-encrypt any custodial
   * private keys still stored as legacy plaintext (principal.privkey,
   * authority_meta.gateway_priv). Idempotent; a no-op once all rows are encrypted.
   */
  private encryptLegacyCustodialRows() {
    const masterKey = masterKeyFromEnv();
    if (!masterKey) return;
    const gw = this.db
      .prepare("SELECT gateway_priv FROM authority_meta WHERE singleton = 1")
      .get() as { gateway_priv: string } | undefined;
    if (gw && !isEncryptedCustodial(gw.gateway_priv)) {
      this.db
        .prepare("UPDATE authority_meta SET gateway_priv = ? WHERE singleton = 1")
        .run(encryptCustodial(gw.gateway_priv, masterKey, CUSTODY_PURPOSES.gateway));
    }
    const plain = this.db
      .prepare("SELECT tenant_id, id, privkey FROM principal WHERE privkey NOT LIKE 'enc:v1:%'")
      .all() as { tenant_id: string; id: string; privkey: string }[];
    const upd = this.db.prepare("UPDATE principal SET privkey = ? WHERE tenant_id = ? AND id = ?");
    for (const row of plain) {
      upd.run(encryptCustodial(row.privkey, masterKey, CUSTODY_PURPOSES.principal), row.tenant_id, row.id);
    }
    if (plain.length > 0) {
      console.log(`[hive-custody] re-encrypted ${plain.length} legacy plaintext principal key(s) under HIVE_MASTER_KEY`);
    }
  }

  /**
   * Default-deny tenant isolation guard (SQLite counterpart to Postgres FORCE RLS).
   */
  public assertTenant(tenantId: string | undefined | null): string {
    if (!tenantId || !tenantId.trim()) {
      throw new ForbiddenError("RLS default-deny: missing tenant_id context");
    }
    return tenantId.trim();
  }

  /**
   * Gateway signing key. When HIVE_GATEWAY_SIGNING_KEY (base64url Ed25519 PKCS8 DER)
   * is set, it overrides the custodial gateway_priv stored in authority_meta so the
   * private key can live outside the database (KMS/HSM-backed env). The DB copy is
   * ignored for signing while the env var is set.
   */
  public gatewaySigningKey(): string {
    const fromEnv = process.env.HIVE_GATEWAY_SIGNING_KEY?.trim();
    if (fromEnv) return fromEnv;
    return this.getMeta().gatewayPriv;
  }

  public getMeta(): AuthorityMeta {
    const row = this.db
      .prepare(
        "SELECT incarnation, gateway_pub, gateway_priv, sim_now_ms, rotated_at FROM authority_meta WHERE singleton = 1",
      )
      .get() as {
      incarnation: string;
      gateway_pub: string;
      gateway_priv: string;
      sim_now_ms: number;
      rotated_at: number;
    };
    return {
      incarnation: row.incarnation,
      gatewayPub: row.gateway_pub,
      gatewayPriv: decryptCustodial(row.gateway_priv, masterKeyFromEnv(), CUSTODY_PURPOSES.gateway),
      simNowMs: Number(row.sim_now_ms),
      rotatedAt: Number(row.rotated_at),
    };
  }

  public now(): number {
    // Wall-clock by default (M5). HIVE_CLOCK_MODE=sim freezes time at the seeded
    // authority_meta.sim_now_ms baseline — tests only.
    if (process.env.HIVE_CLOCK_MODE === "sim") return this.getMeta().simNowMs;
    return Date.now() + this.clockOffsetMs;
  }

  public advanceClock(deltaMs: number): number {
    if (process.env.HIVE_CLOCK_MODE === "sim") {
      const next = this.getMeta().simNowMs + deltaMs;
      this.db
        .prepare("UPDATE authority_meta SET sim_now_ms = ? WHERE singleton = 1")
        .run(next);
      return next;
    }
    this.clockOffsetMs += deltaMs;
    return this.now();
  }

  /**
   * Rotates DB incarnation (mandatory on PITR restore so pre-restore revision &
   * capability tokens cannot replay against rolled-back state).
   */
  public rotateIncarnation(): string {
    const nextInc = crypto.randomUUID();
    const now = this.now();
    this.db
      .prepare(
        "UPDATE authority_meta SET incarnation = ?, rotated_at = ? WHERE singleton = 1",
      )
      .run(nextInc, now);
    return nextInc;
  }

  /**
   * Export raw SQLite backup bytes (used for PITR restore drills & tests).
   */
  public exportBackupTempFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-pitr-"));
    fs.chmodSync(dir, 0o700);
    const tmp = path.join(
      dir,
      `hive-pitr-snap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const escaped = tmp.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}';`);
    fs.chmodSync(tmp, 0o600);
    return tmp;
  }

  /**
   * Restore DB from a PITR backup snapshot and rotate DB incarnation so stale
   * revision/capability tokens minted after the restore point are rejected.
   */
  public restoreFromBackupTempFile(backupFile: string, rotateInc = true): string {
    this.db.close();
    if (this.filePath === ":memory:") {
      // Load backup file into a fresh in-memory DB via ATTACH + copy, or open backup copy
      const copyFile = backupFile + ".restored.db";
      fs.copyFileSync(backupFile, copyFile);
      this.db = new DatabaseSync(copyFile);
    } else {
      // Remove stale WAL/SHM first: a -wal from before the crash would be replayed
      // onto the restored snapshot, corrupting the restored DB (and FTS5 shadow tables).
      fs.rmSync(this.filePath + "-wal", { force: true });
      fs.rmSync(this.filePath + "-shm", { force: true });
      fs.copyFileSync(backupFile, this.filePath);
      this.db = new DatabaseSync(this.filePath);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // FTS5 integrity-check: a snapshot whose FTS shadow tables were mid-write at
    // snapshot time must fail loudly here rather than serve phantom/missing rows.
    const fts = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'event_fts'")
      .get() as { ok: number } | undefined;
    if (fts) {
      this.db.exec("INSERT INTO event_fts(event_fts) VALUES('integrity-check')");
    }
    return rotateInc ? this.rotateIncarnation() : this.getMeta().incarnation;
  }

  public tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const enterDepth = this.txDepth;
      const sp = `sp_${this.txDepth}`;
      this.txDepth++;
      this.db.exec(`SAVEPOINT ${sp};`);
      try {
        const res = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp};`);
        this.txDepth--;
        return res;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
        this.db.exec(`RELEASE SAVEPOINT ${sp};`);
        this.txDepth--;
        // Discard effects hooks registered inside the rolled-back region.
        this.commitHooks = this.commitHooks.filter((h) => h.depth <= enterDepth);
        throw err;
      }
    }
    this.txDepth++;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const res = fn();
      this.db.exec("COMMIT;");
      this.txDepth--;
      this.flushCommitHooks();
      return res;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      this.txDepth--;
      this.commitHooks = [];
      throw err;
    }
  }

  /** Register a post-commit callback. Outside a transaction it runs immediately. */
  public onCommit(cb: () => void): void {
    if (this.txDepth === 0) {
      cb();
      return;
    }
    this.commitHooks.push({ depth: this.txDepth, cb });
  }

  private flushCommitHooks(): void {
    const hooks = this.commitHooks;
    this.commitHooks = [];
    for (const h of hooks) {
      try {
        h.cb();
      } catch (err) {
        // Fan-out listeners must never corrupt a committed tx result.
        console.error("[hive-store] commit hook failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  public close() {
    this.db.close();
  }
}
