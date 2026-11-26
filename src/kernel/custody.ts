/**
 * Custodial key envelope encryption (C6).
 *
 * When HIVE_MASTER_KEY (32 bytes, base64) is set, custodial private keys stored
 * in SQLite/Postgres (principal.privkey, authority_meta.gateway_priv) are
 * AES-256-GCM encrypted at rest under per-column AAD. Rows written before the
 * key was configured (legacy plaintext) are re-encrypted in place at store open.
 * When HIVE_MASTER_KEY is NOT set (local dev only), keys remain plaintext and a
 * loud warning is logged; production boots refuse to start without it.
 */
import crypto from "node:crypto";

const PREFIX = "enc:v1:";

export const CUSTODY_PURPOSES = {
  gateway: "hive-gateway-key/v1",
  principal: "hive-custodial-key/v1",
} as const;

export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.HIVE_MASTER_KEY?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("HIVE_MASTER_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)");
  }
  return buf;
}

export function isEncryptedCustodial(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypt a custodial base64 private key. Idempotent-ish: already-encrypted input is returned unchanged. */
export function encryptCustodial(plainB64: string, masterKey: Buffer, purpose: string): string {
  if (isEncryptedCustodial(plainB64)) return plainB64;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(plainB64, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

/** Decrypt a custodial private key. Legacy plaintext rows pass through unchanged. */
export function decryptCustodial(stored: string, masterKey: Buffer | null, purpose: string): string {
  if (!isEncryptedCustodial(stored)) return stored;
  if (!masterKey) {
    throw new Error(
      "custodial key is envelope-encrypted but HIVE_MASTER_KEY is not set — the gateway refuses to use it",
    );
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAAD(Buffer.from(purpose, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
