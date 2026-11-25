import { hex } from "../lib/util";

export const K = {
  chat: 9,
  react: 7,
  chanNew: 9007,
  patch: 1617,
  open: 1630,
  applied: 1631,
  ci: 30301,
  review: 30302,
  approve: 30303,
  run: 30310,
} as const;

export const KIND_NAME: Record<number, string> = {
  9: "chat",
  7: "reaction",
  9007: "channel",
  1617: "patch · NIP-34",
  1630: "status:open",
  1631: "status:applied",
  30301: "ci-result",
  30302: "review",
  30303: "approval",
  30310: "workflow-run",
};

export interface Attest {
  scope: number[];
  expires: number;
  revoked: boolean;
}
export interface Identity {
  name: string;
  type: "human" | "agent";
  pub: string;
  secret: string;
  owner?: string;
  harness?: string;
  attest?: Attest;
}
export interface BEvent {
  seq: number;
  id: string;
  prev: string;
  kind: number;
  actor: string;
  ch: string;
  content: string;
  tags: string[][];
  ts: number;
  sig: string;
}
export interface Rejection {
  ts: number;
  actor: string;
  kind: number;
  reason: string;
}
export interface Pending {
  runId: string;
  msgId: string;
}
export interface BuzzState {
  now: number;
  ids: Identity[];
  log: BEvent[];
  rejected: Rejection[];
  pending: Pending[];
  wfEnabled: Record<string, boolean>;
  tamper: { seq: number; orig: string } | null;
  runCounter: number;
}
export interface Draft {
  actor: string;
  kind: number;
  ch: string;
  content: string;
  tags?: string[][];
}

const mkId = (name: string, type: Identity["type"], owner?: string, harness?: string, scope?: number[]): Identity => ({
  name,
  type,
  owner,
  harness,
  pub: "npub1" + hex(name + "pub", 22),
  secret: hex(name + "sec", 24),
  attest: scope ? { scope, expires: 480, revoked: false } : undefined,
});

export const BASE_CHANNELS = ["general", "proj-checkout", "releases", "incident-room"];
export const BRANCH_CH = "branch/fix-safari-pay";

export function wireId(ev: Pick<BEvent, "prev" | "kind" | "actor" | "ch" | "content" | "ts" | "tags">) {
  return hex([ev.prev, ev.kind, ev.actor, ev.ch, ev.content, ev.ts, JSON.stringify(ev.tags)].join("|"), 24);
}

export function publish(s: BuzzState, d: Draft): BuzzState {
  const id = s.ids.find((i) => i.name === d.actor);
  const rej = (reason: string): BuzzState => ({
    ...s,
    rejected: [{ ts: s.now, actor: d.actor, kind: d.kind, reason }, ...s.rejected].slice(0, 30),
  });
  if (!id) return rej("auth-required: unknown pubkey");
  if (id.type === "agent") {
    const a = id.attest;
    if (!a) return rej("restricted: no owner attestation");
    if (a.revoked) return rej(`restricted: owner attestation revoked by ${id.owner}`);
    if (a.expires <= s.now) return rej("restricted: owner attestation expired");
    if (!a.scope.includes(d.kind)) return rej(`restricted: kind ${d.kind} (${KIND_NAME[d.kind] ?? "?"}) is outside the attested scope`);
  }
  const prev = s.log.length ? s.log[s.log.length - 1].id : "genesis";
  const tags = d.tags ?? [];
  const base = { prev, kind: d.kind, actor: d.actor, ch: d.ch, content: d.content, ts: s.now, tags };
  const eid = wireId(base);
  const ev: BEvent = { seq: s.log.length + 1, id: eid, ...base, sig: hex(id.secret + eid, 32) };
  let ns: BuzzState = { ...s, log: [...s.log, ev] };

  // workflow hook: a 👍 reaction on a pending release draft completes the run
  if (d.kind === K.react && id.type === "human") {
    const target = tags.find((t) => t[0] === "e")?.[1];
    const p = ns.pending.find((x) => x.msgId === target);
    if (p) {
      ns = { ...ns, pending: ns.pending.filter((x) => x !== p) };
      ns = publish(ns, {
        actor: "goose-triage",
        kind: K.run,
        ch: "releases",
        content: `release-notes · run ${p.runId} · 👍 from ${d.actor} → published v0.4.22 ✅`,
        tags: [["wf", "release-notes"], ["run", p.runId], ["e", target ?? ""]],
      });
    }
  }
  return ns;
}

export type BAction =
  | { t: "publish"; d: Draft }
  | { t: "tick"; m: number }
  | { t: "attest"; agent: string; op: "revoke" | "restore" | "expire" }
  | { t: "tamper"; seq: number }
  | { t: "untamper" }
  | { t: "toggleWf"; id: string }
  | { t: "wfRelease"; phase: 1 | 2 }
  | { t: "reset" };

export function buzzReducer(s: BuzzState, a: BAction): BuzzState {
  switch (a.t) {
    case "reset":
      return seed();
    case "publish":
      return publish(s, a.d);
    case "tick":
      return { ...s, now: s.now + a.m };
    case "attest":
      return {
        ...s,
        ids: s.ids.map((i) =>
          i.name === a.agent && i.attest
            ? {
                ...i,
                attest:
                  a.op === "revoke"
                    ? { ...i.attest, revoked: true }
                    : a.op === "restore"
                      ? { ...i.attest, revoked: false, expires: s.now + 480 }
                      : { ...i.attest, expires: s.now },
              }
            : i,
        ),
      };
    case "tamper": {
      if (s.tamper) return s;
      const ev = s.log[a.seq - 1];
      if (!ev) return s;
      return {
        ...s,
        tamper: { seq: a.seq, orig: ev.content },
        log: s.log.map((e) => (e.seq === a.seq ? { ...e, content: e.content + " [edited by attacker]" } : e)),
      };
    }
    case "untamper":
      if (!s.tamper) return s;
      return { ...s, log: s.log.map((e) => (e.seq === s.tamper!.seq ? { ...e, content: s.tamper!.orig } : e)), tamper: null };
    case "toggleWf":
      return { ...s, wfEnabled: { ...s.wfEnabled, [a.id]: !s.wfEnabled[a.id] } };
    case "wfRelease": {
      const runId = "r" + (s.runCounter + 1);
      if (a.phase === 1)
        return publish(
          { ...s, runCounter: s.runCounter + 1 },
          { actor: "goose-triage", kind: K.run, ch: "releases", content: `release-notes · run ${runId} · triggered by webhook tag v0.4.22`, tags: [["wf", "release-notes"], ["run", runId]] },
        );
      const rid = "r" + s.runCounter;
      const s2 = publish(s, {
        actor: "goose-triage",
        kind: K.chat,
        ch: "releases",
        content:
          "📝 Draft release notes for v0.4.22\n• Fix: Safari 17 'Pay now' button unresponsive (#801)\n• Perf: cart hydration 38% faster\n• Chore: bump deps\nReact 👍 to publish.",
        tags: [["wf", "release-notes"], ["run", rid]],
      });
      const msg = s2.log[s2.log.length - 1];
      return { ...s2, pending: [...s2.pending, { runId: rid, msgId: msg.id }] };
    }
  }
}

export interface VerifyResult {
  ok: boolean;
  bad?: number;
  reason?: string;
}
export function verifyChain(s: BuzzState): VerifyResult {
  for (let i = 0; i < s.log.length; i++) {
    const e = s.log[i];
    const prev = i === 0 ? "genesis" : s.log[i - 1].id;
    if (e.prev !== prev) return { ok: false, bad: e.seq, reason: "prev-hash link broken" };
    if (wireId(e) !== e.id) return { ok: false, bad: e.seq, reason: "content does not match event id (hash mismatch)" };
    const who = s.ids.find((x) => x.name === e.actor);
    if (!who || hex(who.secret + e.id, 32) !== e.sig) return { ok: false, bad: e.seq, reason: "signature invalid" };
  }
  return { ok: true };
}

export function search(s: BuzzState, q: string): BEvent[] {
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length >= 2 && !["have", "the", "this", "that", "seen", "before", "error", "and"].includes(w));
  const all = q.toLowerCase().split(/\W+/).filter((w) => w.length >= 2);
  const terms = words.length ? words : all;
  if (!terms.length) return [];
  return s.log
    .map((e) => ({ e, score: terms.filter((t) => (e.content + " " + e.actor + " " + e.ch + " " + KIND_NAME[e.kind]).toLowerCase().includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.seq - a.e.seq)
    .map((x) => x.e);
}

export function channelsOf(s: BuzzState): string[] {
  const extra = s.log.filter((e) => e.kind === K.chanNew).map((e) => e.content);
  return [...BASE_CHANNELS, ...extra];
}

export function seed(): BuzzState {
  let s: BuzzState = {
    now: -600,
    ids: [
      mkId("ana", "human"),
      mkId("ben", "human"),
      mkId("goose-triage", "agent", "ana", "Goose", [K.chat, K.react, K.run]),
      mkId("codex-fixer", "agent", "ben", "Codex", [K.chat, K.react, K.patch]),
      mkId("claude-reviewer", "agent", "ana", "Claude Code", [K.chat, K.react, K.review]),
      mkId("ci-bot", "agent", "ben", "buzz-cli", [K.ci]),
    ],
    log: [],
    rejected: [],
    pending: [],
    wfEnabled: { "release-notes": true, "triage-on-message": true, "standup-digest": false },
    tamper: null,
    runCounter: 0,
  };
  const say = (actor: string, ch: string, content: string, dt = 5, kind: number = K.chat, tags: string[][] = []) => {
    s = publish({ ...s, now: s.now + dt }, { actor, kind, ch, content, tags });
  };
  say("ana", "general", "Morning all. Reminder: v0.4.22 cut is this afternoon.", 0);
  say("ben", "incident-room", "Checkout 500s spiking — stack trace points at form submit handler on Safari 16.", 60);
  say("goose-triage", "incident-room", "Root cause for the Safari 16 form-submit 500s: missing requestSubmit polyfill. Fixed in PR #4120 by adding the polyfill; deploy rolled out cleanly.", 8);
  say("ana", "incident-room", "Postmortem: alert noise was the real problem — tuned the 5xx threshold, no customer impact.", 90);
  say("ben", "proj-checkout", "Heads up: payment form relies on native submit events — don't break that in the refactor.", 120);
  say("goose-triage", "general", "Weekly digest: 3 bugs closed, 2 open, 1 flaky test (cart-persistence).", 30);
  return { ...s, now: 0 };
}

// ---- agent brains (scripted, offline) ----
export function agentReply(text: string, s: BuzzState): { actor: string; content: string; tags?: string[][] } | null {
  const t = text.toLowerCase();
  if (/(seen|happened).*(before|error)|have we seen/.test(t)) {
    const hits = search(s, text).filter((e) => e.kind === K.chat && e.actor !== "ana" ? true : e.kind === K.chat).slice(0, 3);
    if (!hits.length) return { actor: "goose-triage", content: "I searched the full history (chat, patches, workflow runs, approvals) and found nothing similar." };
    return {
      actor: "goose-triage",
      content:
        "Yes — found " + hits.length + " related events (with receipts):\n" +
        hits.map((h) => `• #${h.seq} in ${h.ch} by ${h.actor}: “${h.content.slice(0, 90)}${h.content.length > 90 ? "…" : ""}”`).join("\n"),
      tags: hits.map((h) => ["e", h.id]),
    };
  }
  if (/@?claude|review/.test(t)) return { actor: "claude-reviewer", content: "On it — I'll take a first-pass review and post findings in the thread." };
  if (/@?codex|@?fixer|fix/.test(t)) return { actor: "codex-fixer", content: "Picking this up. I'll open a branch room and post a patch when ready." };
  if (/@?goose|@?triage|bug|error|broken/.test(t)) return { actor: "goose-triage", content: "Triaged: severity P2, area=checkout. Suggested owner: @codex-fixer." };
  return null;
}
