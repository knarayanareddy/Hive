import crypto from "node:crypto";
import {
  type CapabilityClaims,
  FencedError,
  ForbiddenError,
  IncarnationMismatchError,
} from "./types";

/**
 * Deterministic RFC-8785-style canonical JSON serialization so event IDs,
 * Ed25519 signatures, and VerifiedClose receipts never depend on object key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

const MERKLE_LEAF = Buffer.from([0x00]);
const MERKLE_NODE = Buffer.from([0x01]);

function merkleDigest(parts: Buffer[]): Buffer {
  return crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
}

/**
 * Domain-separated Merkle root: leaves hash as H(0x00 ‖ id-bytes), interior
 * nodes as H(0x01 ‖ left ‖ right). Leaf and node domains can never collide.
 */
export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return merkleDigest([MERKLE_LEAF]).toString("hex");
  let layer = hashes.map((h) => merkleDigest([MERKLE_LEAF, Buffer.from(h, "hex")]));
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? left;
      next.push(merkleDigest([MERKLE_NODE, left, right]));
    }
    layer = next;
  }
  return layer[0].toString("hex");
}

export interface Ed25519KeyPair {
  publicKey: string; // base64url SPKI DER
  privateKey: string; // base64url PKCS8 DER
  fingerprint: string; // compact display key 'ed25519:<16 hex>'
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
  return {
    publicKey: pubDer,
    privateKey: privDer,
    fingerprint: "ed25519:" + sha256(pubDer).slice(0, 20),
  };
}

export function pubkeyFingerprint(pubBase64Url: string): string {
  return "ed25519:" + sha256(pubBase64Url).slice(0, 20);
}

// KeyObject + verdict memoization: verifyLog re-verifies the same (pubkey, id, sig)
// tuples on every state snapshot. DER parsing dominates naive Ed25519 verify; memoizing
// KeyObjects and cacheable verdicts makes repeated verification O(1) while remaining
// exact (the memo key includes the signature, so a swapped sig never hits the cache).
const KEY_CACHE_LIMIT = 512;
const VERIFY_CACHE_LIMIT = 4096;
const privKeyCache = new Map<string, crypto.KeyObject>();
const pubKeyCache = new Map<string, crypto.KeyObject>();
const verifyCache = new Map<string, boolean>();

function cachedPrivateKey(b64: string): crypto.KeyObject {
  let k = privKeyCache.get(b64);
  if (!k) {
    if (privKeyCache.size >= KEY_CACHE_LIMIT) privKeyCache.delete(privKeyCache.keys().next().value!);
    k = crypto.createPrivateKey({
      key: Buffer.from(b64, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    privKeyCache.set(b64, k);
  }
  return k;
}

function cachedPublicKey(b64: string): crypto.KeyObject {
  let k = pubKeyCache.get(b64);
  if (!k) {
    if (pubKeyCache.size >= KEY_CACHE_LIMIT) pubKeyCache.delete(pubKeyCache.keys().next().value!);
    k = crypto.createPublicKey({
      key: Buffer.from(b64, "base64url"),
      format: "der",
      type: "spki",
    });
    pubKeyCache.set(b64, k);
  }
  return k;
}

export function signEd25519(privateKeyBase64Url: string, message: string): string {
  return crypto
    .sign(null, Buffer.from(message, "utf8"), cachedPrivateKey(privateKeyBase64Url))
    .toString("hex");
}

export function verifyEd25519(
  publicKeyBase64Url: string,
  message: string,
  sigHex: string,
): boolean {
  const memoKey = `${publicKeyBase64Url}:${message}:${sigHex}`;
  const hit = verifyCache.get(memoKey);
  if (hit !== undefined) return hit;
  let ok: boolean;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      cachedPublicKey(publicKeyBase64Url),
      Buffer.from(sigHex, "hex"),
    );
  } catch {
    ok = false;
  }
  if (verifyCache.size >= VERIFY_CACHE_LIMIT) verifyCache.delete(verifyCache.keys().next().value!);
  verifyCache.set(memoKey, ok);
  return ok;
}

export function attestationPreimage(params: {
  tenantId: string;
  owner: string;
  agentId: string;
  agentPub: string;
  scope: string[];
  notAfter: number;
}): string {
  return canonicalJson({
    domain: "hive.attestation.v1",
    tenantId: params.tenantId,
    owner: params.owner,
    agentId: params.agentId,
    agentPub: params.agentPub,
    scope: [...params.scope].sort(),
    notAfter: params.notAfter,
  });
}

/**
 * Event content hash. Canonical JSON over a domain-separated object (never a
 * hand-joined pipe preimage), and it binds the attestation chain too.
 */
export function computeEventId(params: {
  prev: string;
  tenantId: string;
  kind: string;
  actor: string;
  channel: string | null;
  taskId: string | null;
  trust: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attest?: string[];
}): string {
  return sha256(
    canonicalJson({
      domain: "hive.event.v1",
      prev: params.prev,
      tenantId: params.tenantId,
      kind: params.kind,
      actor: params.actor,
      channel: params.channel,
      taskId: params.taskId,
      trust: params.trust,
      payload: params.payload,
      createdAt: params.createdAt,
      attest: params.attest ?? [],
    }),
  );
}

export function mintCapabilityToken(
  claims: CapabilityClaims,
  gatewayPrivateKey: string,
): string {
  const encoded = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  const sig = signEd25519(gatewayPrivateKey, "hive.cap.v1." + encoded);
  return `hct_${encoded}.${sig}`;
}

export function verifyCapabilityToken(
  token: string,
  gatewayPublicKey: string,
  expectedTenant: string,
  expectedIncarnation: string,
  nowMs: number,
): CapabilityClaims {
  if (!token.startsWith("hct_")) {
    throw new ForbiddenError("malformed capability token prefix");
  }
  const body = token.slice(4);
  const dot = body.indexOf(".");
  if (dot < 1) {
    throw new ForbiddenError("malformed capability token structure");
  }
  const encoded = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!verifyEd25519(gatewayPublicKey, "hive.cap.v1." + encoded, sig)) {
    throw new ForbiddenError("invalid capability token signature");
  }
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CapabilityClaims;
  } catch {
    throw new ForbiddenError("corrupt capability token claims");
  }
  if (claims.tenant !== expectedTenant) {
    throw new ForbiddenError(
      `capability token tenant mismatch (${claims.tenant} !== ${expectedTenant})`,
    );
  }
  if (claims.incarnation !== expectedIncarnation) {
    throw new IncarnationMismatchError(
      `stale DB incarnation in capability token (${claims.incarnation} !== ${expectedIncarnation}); token invalidated by restore/rotation`,
    );
  }
  if (nowMs > claims.notAfter) {
    throw new FencedError("capability token expired");
  }
  return claims;
}
