import test from "node:test";
import assert from "node:assert/strict";
import { HiveStore } from "../src/kernel/db";
import { seedWorkspace, DEFAULT_TENANT } from "../src/kernel/seed";
import { HiveKernel } from "../src/kernel/authority";
import {
  mintSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForPrincipal,
  hashSessionToken,
  SESSION_TTL_DEFAULT_MS,
} from "../src/kernel/session";

test("auth.session.spec — hst_ sessions: issue, resolve, expire, revoke, constant-time hash compare", () => {
  const store = new HiveStore(":memory:");
  const kernel = new HiveKernel(store);
  seedWorkspace(kernel, DEFAULT_TENANT);

  const now = Date.now();
  const { token, expiresAt } = mintSession(store.db, DEFAULT_TENANT, "ana", SESSION_TTL_DEFAULT_MS, now);
  assert.match(token, /^hst_[A-Za-z0-9_-]{20,}$/);
  assert.equal(expiresAt, now + SESSION_TTL_DEFAULT_MS);

  // Token is stored SHA-256-hashed at rest — the plaintext never touches the DB.
  const stored = store.db.prepare("SELECT token_hash FROM principal_session").get() as {
    token_hash: string;
  };
  assert.equal(stored.token_hash, hashSessionToken(token));
  assert.notEqual(stored.token_hash, token);

  // Resolve round-trip.
  const resolved = resolveSession(store.db, token, now + 1000);
  assert.ok(resolved);
  assert.equal(resolved.tenantId, DEFAULT_TENANT);
  assert.equal(resolved.principalId, "ana");

  // A token minted for one tenant never resolves into another (globex seeded separately).
  seedWorkspace(kernel, "globex");
  const resolvedGlobex = resolveSession(store.db, token, now + 1000);
  assert.equal(resolvedGlobex?.tenantId, DEFAULT_TENANT); // session row pins the issuing tenant

  // Unknown / malformed tokens never resolve.
  assert.equal(resolveSession(store.db, "hst_not-a-real-token", now), null);
  assert.equal(resolveSession(store.db, "hct_aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb", now), null);
  assert.equal(resolveSession(store.db, "", now), null);
  assert.equal(resolveSession(store.db, undefined, now), null);

  // Expired sessions never resolve.
  const shortLived = mintSession(store.db, DEFAULT_TENANT, "ben", 1_000, now);
  assert.ok(resolveSession(store.db, shortLived.token, now + 500));
  assert.equal(resolveSession(store.db, shortLived.token, now + 2_000), null);

  // Revocation kills the session immediately.
  const rev = mintSession(store.db, DEFAULT_TENANT, "dana", 60_000, now);
  assert.equal(revokeSession(store.db, rev.token), true);
  assert.equal(resolveSession(store.db, rev.token, now), null);
  assert.equal(revokeSession(store.db, rev.token), false); // idempotent

  // revoke-all for a principal kills every outstanding session.
  const t1 = mintSession(store.db, DEFAULT_TENANT, "ben", 60_000, now);
  const t2 = mintSession(store.db, DEFAULT_TENANT, "ben", 60_000, now);
  const revoked = revokeAllSessionsForPrincipal(store.db, DEFAULT_TENANT, "ben");
  assert.ok(revoked >= 2);
  assert.equal(resolveSession(store.db, t1.token, now), null);
  assert.equal(resolveSession(store.db, t2.token, now), null);

  // TTL is capped at 24h.
  const capped = mintSession(store.db, DEFAULT_TENANT, "dana", 365 * 24 * 3600 * 1000, now);
  assert.ok(capped.expiresAt <= now + 24 * 3600 * 1000);
});
