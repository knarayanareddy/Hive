/**
 * Principal sessions (hst_<base64url(32B)>) — per-principal HTTP identity.
 *
 * - Tokens are issued ONLY via the admin bootstrap (`POST /api/session/mint`,
 *   gated by HIVE_ADMIN_TOKEN) and stored SHA-256-hashed at rest.
 * - Resolution does a constant-time compare of the SHA-256 hash (timingSafeEqual).
 * - Sessions carry a TTL (default 12h) and a revoked flag; `last_used_at` is
 *   updated on each resolution.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_TTL_DEFAULT_MS = 12 * 60 * 60 * 1000; // 12h
export const SESSION_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24h hard cap

export interface ResolvedSession {
  tenantId: string;
  principalId: string;
  expiresAt: number;
  sessionHash: string;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintSession(
  db: DatabaseSync,
  tenantId: string,
  principalId: string,
  ttlMs: number = SESSION_TTL_DEFAULT_MS,
  nowMs: number = Date.now(),
): { token: string; expiresAt: number } {
  const ttl = Math.min(Math.max(1, ttlMs), SESSION_TTL_MAX_MS);
  const token = `hst_${crypto.randomBytes(32).toString("base64url")}`;
  const tokenHash = hashSessionToken(token);
  const expiresAt = nowMs + ttl;
  db.prepare(
    `INSERT INTO principal_session
       (token_hash, tenant_id, principal_id, created_at, expires_at, last_used_at, revoked)
     VALUES (?, ?, ?, ?, ?, NULL, 0)`,
  ).run(tokenHash, tenantId, principalId, nowMs, expiresAt);
  return { token, expiresAt };
}

/**
 * Resolve an hst_… bearer to its principal. Returns null for malformed, unknown,
 * expired, or revoked tokens. Constant-time on the hash comparison.
 */
export function resolveSession(
  db: DatabaseSync,
  token: string | undefined | null,
  nowMs: number = Date.now(),
): ResolvedSession | null {
  if (!token || !token.startsWith("hst_")) return null;
  const candidate = hashSessionToken(token);
  const row = db
    .prepare(
      `SELECT token_hash, tenant_id, principal_id, expires_at, revoked
         FROM principal_session WHERE token_hash = ?`,
    )
    .get(candidate) as
    | {
        token_hash: string;
        tenant_id: string;
        principal_id: string;
        expires_at: number;
        revoked: number;
      }
    | undefined;
  if (!row) return null;
  // Constant-time comparison of the stored vs. candidate hash.
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(row.token_hash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (row.revoked !== 0) return null;
  if (row.expires_at <= nowMs) return null;
  try {
    db.prepare(`UPDATE principal_session SET last_used_at = ? WHERE token_hash = ?`).run(
      nowMs,
      row.token_hash,
    );
  } catch {
    /* last_used_at is best-effort; resolution result stands */
  }
  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    expiresAt: row.expires_at,
    sessionHash: row.token_hash,
  };
}

export function revokeSession(db: DatabaseSync, token: string): boolean {
  if (!token || !token.startsWith("hst_")) return false;
  const res = db
    .prepare(`UPDATE principal_session SET revoked = 1 WHERE token_hash = ? AND revoked = 0`)
    .run(hashSessionToken(token));
  return Number(res.changes) > 0;
}

export function revokeAllSessionsForPrincipal(
  db: DatabaseSync,
  tenantId: string,
  principalId: string,
): number {
  const res = db
    .prepare(
      `UPDATE principal_session SET revoked = 1
       WHERE tenant_id = ? AND principal_id = ? AND revoked = 0`,
    )
    .run(tenantId, principalId);
  return Number(res.changes);
}
