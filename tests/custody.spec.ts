import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { HiveStore } from "../src/kernel/db";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import {
  CUSTODY_PURPOSES,
  decryptCustodial,
  encryptCustodial,
  isEncryptedCustodial,
  masterKeyFromEnv,
} from "../src/kernel/custody";

test("custody.spec — AES-256-GCM envelope for custodial keys; legacy rows re-encrypt at open", () => {
  const masterKey = crypto.randomBytes(32);
  const prev = process.env.HIVE_MASTER_KEY;
  process.env.HIVE_MASTER_KEY = masterKey.toString("base64");
  try {
    // ── Round-trip + tamper ─────────────────────────────────────────────
    const secret = crypto.randomBytes(32).toString("base64");
    const enc = encryptCustodial(secret, masterKey, CUSTODY_PURPOSES.principal);
    assert.ok(isEncryptedCustodial(enc));
    assert.notEqual(enc, secret);
    assert.equal(decryptCustodial(enc, masterKey, CUSTODY_PURPOSES.principal), secret);
    // Wrong purpose (AAD transplant attempt) fails.
    assert.throws(() => decryptCustodial(enc, masterKey, CUSTODY_PURPOSES.gateway));
    // Wrong key fails.
    assert.throws(() => decryptCustodial(enc, crypto.randomBytes(32), CUSTODY_PURPOSES.principal));
    // Bit-flipped ciphertext fails GCM auth.
    const buf = Buffer.from(enc.slice("enc:v1:".length), "base64url");
    buf[20] ^= 0x01;
    assert.throws(() =>
      decryptCustodial("enc:v1:" + buf.toString("base64url"), masterKey, CUSTODY_PURPOSES.principal),
    );
    // Legacy plaintext passes through when no master key is configured.
    assert.equal(decryptCustodial(secret, null, CUSTODY_PURPOSES.principal), secret);

    // masterKeyFromEnv enforces 32 bytes.
    assert.throws(() => masterKeyFromEnv({ HIVE_MASTER_KEY: "dG9vLXNob3J0" } as any));
    assert.equal(masterKeyFromEnv({} as any), null);

    // ── Fresh store under a master key encrypts rows at rest ─────────────
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-custody-"));
    const dbPath = path.join(dir, "custody.db");
    const store = new HiveStore(dbPath);
    const kernel = new HiveKernel(store);
    seedWorkspace(kernel, DEFAULT_TENANT);
    const raw = store.db
      .prepare("SELECT privkey FROM principal WHERE tenant_id = ? AND kind = 'human' LIMIT 1")
      .get(DEFAULT_TENANT) as { privkey: string };
    assert.ok(isEncryptedCustodial(raw.privkey), "principal.privkey must be encrypted at rest");
    const rawGw = store.db
      .prepare("SELECT gateway_priv FROM authority_meta WHERE singleton = 1")
      .get() as { gateway_priv: string };
    assert.ok(isEncryptedCustodial(rawGw.gateway_priv), "authority_meta.gateway_priv must be encrypted at rest");
    store.close();
    // ── Reopen: keys decrypt transparently, kernel works ─────────────────
    const store2 = new HiveStore(dbPath);
    const kernel2 = new HiveKernel(store2);
    const claim = kernel2.claimTask(DEFAULT_TENANT, { taskId: "801", actor: "fixer" });
    assert.ok(claim.token.length > 20);
    store2.close();
    fs.rmSync(dir, { recursive: true, force: true });

    // ── Legacy plaintext rows are re-encrypted at open ───────────────────
    delete process.env.HIVE_MASTER_KEY;
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "hive-custody-legacy-"));
    const legacyPath = path.join(dir2, "legacy.db");
    const legacyStore = new HiveStore(legacyPath);
    const legacyKernel = new HiveKernel(legacyStore);
    seedWorkspace(legacyKernel, DEFAULT_TENANT);
    legacyStore.close();
    process.env.HIVE_MASTER_KEY = masterKey.toString("base64");
    const migrated = new HiveStore(legacyPath);
    const row = migrated.db
      .prepare("SELECT privkey FROM principal WHERE tenant_id = ? AND kind = 'human' LIMIT 1")
      .get(DEFAULT_TENANT) as { privkey: string };
    assert.ok(isEncryptedCustodial(row.privkey), "legacy plaintext rows must be re-encrypted at open");
    const rowGw = migrated.db
      .prepare("SELECT gateway_priv FROM authority_meta WHERE singleton = 1")
      .get() as { gateway_priv: string };
    assert.ok(isEncryptedCustodial(rowGw.gateway_priv));
    migrated.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.HIVE_MASTER_KEY;
    else process.env.HIVE_MASTER_KEY = prev;
  }
});
