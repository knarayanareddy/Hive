import { attestationPreimage, verifyEd25519 } from "./crypto";
import {
  type CapabilityClaims,
  ForbiddenError,
  type GatePolicy,
  type GrantRecord,
  type Principal,
  type TaskRecord,
} from "./types";

export interface GrantExplain {
  ok: boolean;
  why: string;
  grant?: GrantRecord;
}

/**
 * Board-style path-prefix + principal-specificity grant resolution with `explain`.
 */
export function explainGrant(
  grants: GrantRecord[],
  principalId: string,
  channelOrPath: string,
  op: "read" | "post",
): GrantExplain {
  const normPath = channelOrPath.endsWith("/") ? channelOrPath : channelOrPath + "/";
  const specificity = (g: GrantRecord) => (g.principal === "everyone" ? 0 : 1);
  const matching = grants
    .filter(
      (g) =>
        normPath.startsWith(g.path) &&
        (g.principal === principalId || g.principal === "everyone"),
    )
    .sort((a, b) => b.path.length - a.path.length || specificity(b) - specificity(a));

  if (matching.length === 0) {
    return {
      ok: false,
      why: `no grant matches ${principalId} on ${normPath} (default-deny)`,
    };
  }
  const top = matching[0];
  if (top.can.includes("none")) {
    return {
      ok: false,
      why: `${top.id}: ${top.principal} ${top.path || "/"}=none`,
      grant: top,
    };
  }
  const ok = top.can.includes("all") || top.can.includes(op);
  return {
    ok,
    why: `${top.id}: ${top.principal} ${top.path || "/"}=${top.can.join(",")}`,
    grant: top,
  };
}

/**
 * Buzz-style Owner Attestation verification:
 * - Humans are roots of authority (no attestation required).
 * - Agents MUST carry a valid non-revoked, non-expired attestation signed by a DIFFERENT human owner,
 *   whose scope covers `requiredOp`.
 */
/**
 * Human role requirements for privileged ops. Humans are roots of authority for
 * most actions, but a subset of high-trust ops is role-gated so a low-privilege
 * member cannot fabricate verifier receipts or override protected gates.
 * Agents are governed by their Owner Attestation scope instead (see below).
 */
const HUMAN_SCOPED_OPS: ReadonlyArray<{ op: string; roles: readonly string[] }> = [
  { op: "task.verify", roles: ["owner", "lead", "security", "verifier"] },
  { op: "agent.attestation.manage", roles: ["owner"] },
];

export function verifyPrincipalAuthority(
  principal: Principal,
  ownerPrincipal: Principal | undefined,
  requiredOp: string,
  nowMs: number,
): { attestChain: string[] } {
  if (principal.kind === "human") {
    const need = HUMAN_SCOPED_OPS.find(({ op }) => matchScopePattern(op, requiredOp));
    if (need && !need.roles.includes(principal.role)) {
      throw new ForbiddenError(
        `human ${principal.id} (role=${principal.role}) may not perform "${requiredOp}" (requires role: ${need.roles.join(", ")})`,
      );
    }
    return { attestChain: [`human:${principal.id} (role=${principal.role})`] };
  }
  const att = principal.attestation;
  if (!att || !principal.owner) {
    throw new ForbiddenError(`agent ${principal.id} has no owner attestation`);
  }
  if (principal.owner === principal.id) {
    throw new ForbiddenError(`self-attestation forbidden for ${principal.id}`);
  }
  if (!ownerPrincipal || ownerPrincipal.kind !== "human") {
    throw new ForbiddenError(
      `attesting owner ${principal.owner} is not a registered human root`,
    );
  }
  if (att.revoked) {
    throw new ForbiddenError(
      `owner attestation for ${principal.id} was revoked by ${principal.owner}`,
    );
  }
  if (att.notAfter <= nowMs) {
    throw new ForbiddenError(`owner attestation for ${principal.id} expired`);
  }
  const preimage = attestationPreimage({
    tenantId: principal.tenantId,
    owner: principal.owner,
    agentId: principal.id,
    agentPub: principal.pubkey,
    scope: att.scope,
    notAfter: att.notAfter,
  });
  if (!verifyEd25519(ownerPrincipal.pubkey, preimage, att.sig)) {
    throw new ForbiddenError(
      `owner attestation signature invalid for ${principal.id}`,
    );
  }
  const allowed = att.scope.some((pattern) => matchScopePattern(pattern, requiredOp));
  if (!allowed) {
    throw new ForbiddenError(
      `operation "${requiredOp}" is outside ${principal.id}'s attested scope [${att.scope.join(", ")}]`,
    );
  }
  return {
    attestChain: [
      `owner:${principal.owner} -> agent:${principal.id} scope=[${att.scope.join(",")}] exp=${att.notAfter}`,
    ],
  };
}

export function matchScopePattern(pattern: string, op: string): boolean {
  if (pattern === "*" || pattern === op) return true;
  if (pattern.endsWith("*")) {
    return op.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function assertCapabilityAllows(claims: CapabilityClaims, requiredOp: string) {
  const ok = claims.ops.some((p) => matchScopePattern(p, requiredOp));
  if (!ok) {
    throw new ForbiddenError(
      `capability token for ${claims.sub} lacks "${requiredOp}" (granted: [${claims.ops.join(", ")}])`,
    );
  }
}

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "stripe_live_key", re: /\bsk_live_[A-Za-z0-9_]{6,}/ },
  { name: "stripe_restricted_key", re: /\brk_live_[A-Za-z0-9_]{6,}/ },
  { name: "aws_access_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github_pat_classic", re: /\bgh[pousr]_[A-Za-z0-9_]{12,}/ },
  { name: "github_pat_fine_grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "openai_project_key", re: /\bsk-proj-[A-Za-z0-9_-]{10,}/ },
  { name: "hive_capability_token", re: /\bhct_[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}/ },
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "deploy_key_leak", re: /\bDEPLOY_KEY\s*=\s*\S+/i },
];

export function scanSecretSpans(text: string): string[] {
  const hits: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) hits.push(p.name);
  }
  return hits;
}

/**
 * Outbound Data Loss Prevention (DLP) check — blocks key-shaped secrets from being
 * posted into channels or synced out to Slack/GitHub.
 */
export function enforceOutboundDlp(text: string) {
  const hits = scanSecretSpans(text);
  if (hits.length > 0) {
    throw new ForbiddenError(
      `DLP blocked outbound payload containing secret pattern (${hits.join(", ")})`,
    );
  }
}

export function resolveGatePolicyForPath(
  protectedPath: string | null | undefined,
  explicitPolicy?: GatePolicy,
): GatePolicy {
  if (explicitPolicy && explicitPolicy !== "none") return explicitPolicy;
  if (!protectedPath) return explicitPolicy ?? "none";
  if (/^(security|infra\/prod)\//i.test(protectedPath)) return "two_of_three";
  if (/^(payments|billing|auth)\//i.test(protectedPath)) return "one";
  return explicitPolicy ?? "none";
}

export function gatePolicyForTask(task: Pick<TaskRecord, "protectedPath" | "gatePolicy">): GatePolicy {
  return resolveGatePolicyForPath(task.protectedPath, task.gatePolicy);
}
