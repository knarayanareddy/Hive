import crypto from "node:crypto";
import {
  type CapabilityClaims,
  FencedError,
  ForbiddenError,
  IncarnationMismatchError,
  type RevisionToken,
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

export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256("empty");
  let layer = [...hashes];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? left;
      next.push(sha256(left + ":" + right));
    }
    layer = next;
  }
  return layer[0];
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

export function signEd25519(privateKeyBase64Url: string, message: string): string {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64Url, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(message, "utf8"), privKey).toString("hex");
}

export function verifyEd25519(
  publicKeyBase64Url: string,
  message: string,
  sigHex: string,
): boolean {
  try {
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64Url, "base64url"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      pubKey,
      Buffer.from(sigHex, "hex"),
    );
  } catch {
    return false;
  }
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
}): string {
  return sha256(
    [
      params.prev,
      params.tenantId,
      params.kind,
      params.actor,
      params.channel ?? "",
      params.taskId ?? "",
      params.trust,
      canonicalJson(params.payload),
      String(params.createdAt),
    ].join("|"),
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

export function encodeRevisionToken(rev: RevisionToken, gatewayPrivateKey: string): string {
  const encoded = Buffer.from(canonicalJson(rev), "utf8").toString("base64url");
  const sig = signEd25519(gatewayPrivateKey, "hive.rev.v1." + encoded);
  return `hrv_${encoded}.${sig}`;
}

export function verifyRevisionToken(
  token: string,
  gatewayPublicKey: string,
  expectedTenant: string,
  expectedIncarnation: string,
): RevisionToken {
  if (!token.startsWith("hrv_")) {
    throw new ForbiddenError("malformed revision token");
  }
  const body = token.slice(4);
  const dot = body.indexOf(".");
  if (dot < 1) throw new ForbiddenError("malformed revision token");
  const encoded = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!verifyEd25519(gatewayPublicKey, "hive.rev.v1." + encoded, sig)) {
    throw new ForbiddenError("invalid revision token signature");
  }
  const rev = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RevisionToken;
  if (rev.tenant !== expectedTenant) {
    throw new ForbiddenError("revision token tenant mismatch");
  }
  if (rev.incarnation !== expectedIncarnation) {
    throw new IncarnationMismatchError(
      `stale DB incarnation in revision token (${rev.incarnation} !== ${expectedIncarnation})`,
    );
  }
  return rev;
}
