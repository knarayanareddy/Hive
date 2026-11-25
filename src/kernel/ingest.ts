import { scanSecretSpans } from "./policy";
import type { InboundMessage, Principal, Trust } from "./types";

const INSTRUCTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ignore_previous", re: /ignore\s+(all|previous|prior)\s+instructions/i },
  { name: "system_override", re: /\bsystem\s*:/i },
  { name: "imperative_override", re: /\byou\s+must\s+now\b/i },
  { name: "exfiltrate_env", re: /\b(print|dump|echo|post|send)\s+\$[A-Z0-9_]{3,}/i },
  { name: "unauthorized_merge", re: /\bmerge\s+(it\s+)?to\s+main\b/i },
  { name: "xml_breakout", re: /<\/?untrusted\b|<\/?system\b/i },
];

export interface RawInboundInput {
  source: InboundMessage["source"];
  principalId: string;
  channel: string;
  text: string;
  externalRef?: string;
  knownPrincipal?: Principal;
  explicitTrust?: Trust;
}

export function classifyPrincipalTrust(
  knownPrincipal?: Principal,
  explicitTrust?: Trust,
): Trust {
  if (explicitTrust) return explicitTrust;
  if (!knownPrincipal) return "external";
  if (knownPrincipal.kind === "human" && knownPrincipal.role === "owner") {
    return "owner";
  }
  return "member";
}

export function renderInboundForAgent(msg: {
  source: string;
  principal: string;
  trust: Trust;
  text: string;
}): string {
  if (msg.trust === "external") {
    const escaped = msg.text
      .replace(/<\/untrusted>/gi, "&lt;/untrusted&gt;")
      .replace(/<untrusted/gi, "&lt;untrusted");
    return `<untrusted source="${msg.source}" user="${msg.principal}">\n${escaped}\n</untrusted>`;
  }
  return msg.text;
}

/**
 * Algorithm 4 · Ingest with trust labels & prompt-injection posture.
 * External text is strictly quoted data; capabilities (never message wording)
 * govern what an agent can execute.
 */
export function ingestInbound(raw: RawInboundInput): InboundMessage {
  const trust = classifyPrincipalTrust(raw.knownPrincipal, raw.explicitTrust);
  const matchedSpans: string[] = [];
  for (const pat of INSTRUCTION_PATTERNS) {
    if (pat.re.test(raw.text)) matchedSpans.push(pat.name);
  }
  const secretHits = scanSecretSpans(raw.text);
  const hasSecretEnvRef = /\$[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*/i.test(raw.text);
  if (hasSecretEnvRef) matchedSpans.push("env_secret_reference");
  for (const sh of secretHits) matchedSpans.push(`secret:${sh}`);

  const instructionLike = matchedSpans.some((s) => !s.startsWith("secret:"));
  const secretLike = secretHits.length > 0 || hasSecretEnvRef;

  return {
    source: raw.source,
    principal: raw.principalId,
    trust,
    channel: raw.channel,
    text: raw.text,
    externalRef: raw.externalRef,
    flags: {
      instructionLike,
      secretLike,
      matchedSpans,
    },
    renderedForAgent: renderInboundForAgent({
      source: raw.source,
      principal: raw.principalId,
      trust,
      text: raw.text,
    }),
  };
}
