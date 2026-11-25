import fs from "node:fs";
import path from "node:path";
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

    const existing = this.db
      .prepare("SELECT incarnation FROM authority_meta WHERE singleton = 1")
      .get() as { incarnation: string } | undefined;

    if (!existing) {
      const kp = generateEd25519KeyPair();
      const now = 1795606800000; // 2026-11-25T09:00:00Z baseline
      this.db
        .prepare(
          `INSERT INTO authority_meta (singleton, incarnation, gateway_pub, gateway_priv, sim_now_ms, rotated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), kp.publicKey, kp.privateKey, now, now);
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
      gatewayPriv: row.gateway_priv,
      simNowMs: Number(row.sim_now_ms),
      rotatedAt: Number(row.rotated_at),
    };
  }

  public now(): number {
    return this.getMeta().simNowMs;
  }

  public advanceClock(deltaMs: number): number {
    const next = this.now() + deltaMs;
    this.db
      .prepare("UPDATE authority_meta SET sim_now_ms = ? WHERE singleton = 1")
      .run(next);
    return next;
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
    const tmp = path.join(
      "/tmp",
      `hive-pitr-snap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const escaped = tmp.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}';`);
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
      fs.copyFileSync(backupFile, this.filePath);
      this.db = new DatabaseSync(this.filePath);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    return rotateInc ? this.rotateIncarnation() : this.getMeta().incarnation;
  }

  public tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
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
        throw err;
      }
    }
    this.txDepth++;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const res = fn();
      this.db.exec("COMMIT;");
      this.txDepth--;
      return res;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      this.txDepth--;
      throw err;
    }
  }

  public close() {
    this.db.close();
  }
}
