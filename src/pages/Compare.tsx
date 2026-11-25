import { useState } from "react";
import { ExternalLink, AlertTriangle, Plus, Puzzle } from "lucide-react";
import { Badge, Card, SectionTitle } from "../components/ui";
import { cn } from "../utils/cn";

const ROWS: { dim: string; board: string; buzz: string; take: string }[] = [
  { dim: "What it is", board: "Headless message store / coordination primitive for agents (“headless Slack”)", buzz: "Self-hostable workspace: chat + git forge + workflows + agents on one relay", take: "Board is a primitive; Buzz is a platform" },
  { dim: "Announced", board: "Nov 18, 2026 — experimental, free on all plans for now", buzz: "Jul 21, 2026 — v0.4.21, open source (Apache-2.0)", take: "Both early; neither claims production-readiness" },
  { dim: "Core abstraction", board: "Channels → threads → tasks (claim, lease, deps), labels, watchers", buzz: "One signed Nostr event log; everything is an event (chat, patch, approval, run)", take: "Tasks vs events — complementary" },
  { dim: "Identity", board: "Grants per user / project / environment; events record who acted", buzz: "Keypair per human and agent + Owner Attestation (scoped, time-bound)", take: "Buzz: stronger provenance. Board: simpler grants" },
  { dim: "Agent interface", board: "`vercel board` CLI + JS SDK + skill (`npx skills add vercel/board`)", buzz: "buzz-cli (JSON in/out) + buzz-acp harness for Goose, Codex, Claude Code", take: "Both harness-agnostic" },
  { dim: "Task coordination", board: "First-class: claim, renew lease, complete, task dependencies, swarms", buzz: "Not a primitive — approximated with channels, workflows and reactions", take: "Board wins clearly" },
  { dim: "Waking agents", board: "Watchers on reply/label + `board schedule --in 5m`; no resident process", buzz: "YAML workflows with message / reaction / schedule / webhook triggers", take: "Board: agent-centric. Buzz: workflow-centric" },
  { dim: "Integrations", board: "Two-way sync with Slack, GitHub, Linear via Vercel Connect", buzz: "Replace Slack & GitHub rather than integrate (own forge, own chat)", take: "Board meets teams where they are" },
  { dim: "Human experience", board: "Board viewer (`inspect`); headless by design", buzz: "Desktop apps, DMs, canvases, media, search, huddles (mobile WIP)", take: "Buzz wins on UX" },
  { dim: "Code & review", board: "Syncs GitHub PR events as messages", buzz: "NIP-34 patches, git hosting, branch-as-room, review & approval in channel", take: "Buzz wins" },
  { dim: "Audit & integrity", board: "Event log records actor; trust the host", buzz: "Signed events + hash-chained audit log; tamper-evident", take: "Buzz wins" },
  { dim: "Structured data", board: "Schema-validated messages (e.g. security-finding@1)", buzz: "Typed event kinds", take: "Board's registry is more ergonomic for agents" },
  { dim: "Sandbox/credential story", board: "sandboxPolicy: no credential inside Vercel Sandbox; scoped routes only", buzz: "Agent keys scoped by identity and attestation", take: "Complementary" },
  { dim: "Sovereignty", board: "Runs on / best with Vercel", buzz: "Self-host a relay you own (centralised per community today)", take: "Buzz wins" },
  { dim: "Known gaps", board: "Experimental; no API stability; “agents read messages as instructions”", buzz: "Approval gates have no completed execution path; mobile & push pending; single relay", take: "Both leave safety to you" },
  { dim: "Proof points", board: "Powers Vercel's security swarm; v0 software factory merges >50% of PRs (self-reported)", buzz: "Block runs it internally as first reference customer", take: "Treat vendor claims as claims" },
];

const AXES = ["Task coordination", "Agent identity", "Human chat UX", "Code forge & rooms", "Tool integrations", "Sovereignty", "Harness neutrality", "Enforcement & safety", "Wake & schedule", "Auditability"];
const SERIES = [
  { id: "board", name: "Vercel Board", color: "#f4f4f5", v: [5, 2, 2, 1, 5, 2, 5, 3, 5, 3] },
  { id: "buzz", name: "Buzz", color: "#fbbf24", v: [2, 5, 4, 4, 2, 5, 4, 2, 3, 5] },
  { id: "hive", name: "Combined v2 (proposed)", color: "#34d399", v: [5, 5, 4, 4, 5, 4, 5, 5, 5, 5] },
];

function Radar({ on }: { on: string[] }) {
  const cx = 230,
    cy = 220,
    R = 150;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / AXES.length - Math.PI / 2;
    return [cx + Math.cos(a) * R * (v / 5), cy + Math.sin(a) * R * (v / 5)];
  };
  return (
    <svg viewBox="0 0 460 440" className="mx-auto w-full max-w-[520px]">
      {[1, 2, 3, 4, 5].map((r) => (
        <polygon key={r} points={AXES.map((_, i) => pt(i, r).join(",")).join(" ")} fill="none" stroke="#3f3f46" strokeWidth={r === 5 ? 1.2 : 0.6} />
      ))}
      {AXES.map((a, i) => {
        const [x, y] = pt(i, 5);
        const [lx, ly] = pt(i, 5.9);
        return (
          <g key={a}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#3f3f46" strokeWidth={0.6} />
            <text x={lx} y={ly} fontSize={10} fill="#a1a1aa" textAnchor={lx < cx - 8 ? "end" : lx > cx + 8 ? "start" : "middle"} dominantBaseline="middle">{a}</text>
          </g>
        );
      })}
      {SERIES.filter((s) => on.includes(s.id)).map((s) => (
        <g key={s.id}>
          <polygon points={s.v.map((v, i) => pt(i, v).join(",")).join(" ")} fill={s.color} fillOpacity={0.14} stroke={s.color} strokeWidth={2} />
          {s.v.map((v, i) => {
            const [x, y] = pt(i, v);
            return <circle key={i} cx={x} cy={y} r={3} fill={s.color} />;
          })}
        </g>
      ))}
    </svg>
  );
}

const TAKE = [
  { from: "Board", tone: "white" as const, items: ["Task primitive: claim · lease · renew · complete · dependencies", "Watchers + schedule: agents sleep, events wake them", "Structured, schema-validated messages", "Per-channel grants with an `explain` command", "Two-way Slack / GitHub / Linear sync", "Sandbox access with no credentials inside"] },
  { from: "Buzz", tone: "amber" as const, items: ["Signed, hash-chained events as a single source of truth", "Owner Attestations: authorship vs authority", "Branch-as-room: patch, CI, review, merge in one place", "One search across chat, code, runs and approvals", "YAML workflows with webhook/reaction/schedule triggers", "Self-hostable, open, harness-neutral (ACP)"] },
];
const LIMITS = [
  "Chat is the authority: “done” means someone said done (Projection ≠ Authority).",
  "Leases are advisory — a stale agent can still write after its lease is reassigned.",
  "Anything an agent reads can be an instruction — including a guest's Slack message.",
  "Approval gates aren't enforced end-to-end; a green CI + agent LGTM can merge.",
  "No independent verification: the author's claim closes the task.",
  "No idempotency for external effects: crash + retry duplicates PRs and posts.",
  "No budgets or loop protection: the invoice is the alert.",
  "Long-running ‘--wait’ loops or prompt-remembered renewals are brittle.",
];
const ADDS = [
  ["Authority kernel", "Typed commands over a CAS state machine; chat becomes a projection"],
  ["Lease fencing", "lease_epoch on every write; zombies get 409"],
  ["VerifiedClose", "Independent verifier + evidence receipt required to close"],
  ["Trust labels + capability tokens", "External text is data; tokens bound to task, epoch, ops, expiry"],
  ["Enforced approval gates", "SHA-bound, invalidated by new commits, N-of-M"],
  ["Idempotent outbox", "Exactly-once PR / merge / Slack effects with read-back"],
  ["Budget + circuit breaker", "Meter spend, detect loops, halt and escalate"],
  ["Wake queue + /commands", "Unread working-set diffs; deterministic registered verbs"],
  ["Local ⇄ cloud authority", "SQLite → Postgres (RLS) behind RemoteAuthority, PITR-safe tokens"],
];

export default function Compare() {
  const [on, setOn] = useState<string[]>(["board", "buzz", "hive"]);
  return (
    <div className="space-y-8">
      <SectionTitle
        eyebrow="Compare & contrast"
        title="Vercel Board vs Buzz — a primitive vs a platform"
        sub="Both put humans and agents in the same room and both are early. Board gives agents a coordination primitive that plugs into the tools you already use. Buzz replaces those tools with one signed event log you own."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <Badge tone="white">Vercel Board</Badge>
          <div className="mt-3 text-lg font-semibold text-white">Coordination primitive</div>
          <p className="mt-1 text-sm text-zinc-400">“Which agent owns this task, is it still alive, and what can start now?” — answered by leases, dependencies, watchers and grants.</p>
        </Card>
        <Card className="border-amber-500/20 p-5">
          <Badge tone="amber">Buzz</Badge>
          <div className="mt-3 text-lg font-semibold text-white">Collaboration platform</div>
          <p className="mt-1 text-sm text-zinc-400">“Who did this, can I prove it, and where is the code, chat and approval for it?” — answered by signed events and one searchable log.</p>
        </Card>
        <Card className="border-emerald-500/20 p-5">
          <Badge tone="emerald">Combined (proposed)</Badge>
          <div className="mt-3 text-lg font-semibold text-white">Fenced, verified plane</div>
          <p className="mt-1 text-sm text-zinc-400">Board's task semantics + Buzz's provable identity and log, with an authority kernel so that “done” means <i>verified</i>.</p>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500">
              <th className="p-3 font-medium">Dimension</th>
              <th className="p-3 font-medium text-white">Vercel Board</th>
              <th className="p-3 font-medium text-amber-300">Buzz</th>
              <th className="p-3 font-medium text-emerald-300">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/80">
            {ROWS.map((r) => (
              <tr key={r.dim} className="align-top">
                <td className="p-3 font-semibold text-zinc-100">{r.dim}</td>
                <td className="p-3 text-zinc-300">{r.board}</td>
                <td className="p-3 text-zinc-300">{r.buzz}</td>
                <td className="p-3 text-emerald-200/90">{r.take}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <Card className="p-5">
          <div className="mb-1 text-sm font-semibold text-white">Capability radar</div>
          <p className="mb-3 text-xs text-zinc-500">Subjective 0–5 scores from public docs and launch coverage. Useful for shape, not precision.</p>
          <div className="mb-2 flex flex-wrap gap-2">
            {SERIES.map((s) => (
              <button key={s.id} onClick={() => setOn((o) => (o.includes(s.id) ? o.filter((x) => x !== s.id) : [...o, s.id]))} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", on.includes(s.id) ? "border-zinc-500 text-white" : "border-zinc-800 text-zinc-600")}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color, opacity: on.includes(s.id) ? 1 : 0.3 }} /> {s.name}
              </button>
            ))}
          </div>
          <Radar on={on} />
        </Card>
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><Puzzle size={15} className="text-violet-300" /> Best aspects to keep</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {TAKE.map((t) => (
                <div key={t.from}>
                  <Badge tone={t.tone}>from {t.from}</Badge>
                  <ul className="mt-2 space-y-1.5 text-xs text-zinc-300">
                    {t.items.map((i) => <li key={i} className="flex gap-1.5"><span className="text-emerald-400">✓</span>{i}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
          <Card className="border-rose-500/20 p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><AlertTriangle size={15} className="text-rose-300" /> Where the plain union is limiting</div>
            <ul className="space-y-1.5 text-xs text-zinc-300">
              {LIMITS.map((l) => <li key={l} className="flex gap-1.5"><span className="text-rose-400">!</span>{l}</li>)}
            </ul>
          </Card>
        </div>
      </div>

      <Card className="border-emerald-500/20 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Plus size={15} className="text-emerald-300" /> Features added in the combined v2</div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {ADDS.map(([t, d]) => (
            <div key={t} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              <div className="text-xs font-semibold text-emerald-300">{t}</div>
              <div className="mt-0.5 text-xs text-zinc-400">{d}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <div className="text-sm font-semibold text-white">Where the “Projection ≠ Authority” idea comes from</div>
        <p className="mt-2 max-w-4xl text-sm leading-relaxed text-zinc-400">
          The X post you linked (Ruiteng Huang, on LoopX) reacts to Matt Pocock's wishlist for a vendor-neutral Board with a local wake-queue for sleeping agents, scheduling and deterministic registered commands. His core argument: after running 10+ cross-host agents for 18–200 hours, a chat stream can't be the authoritative state machine — a “fixed” message isn't independent acceptance, and renewing a lease can't depend on a probabilistic, context-compressing model remembering to do it. His answer is a transactional kernel with lease epochs and fencing, verified close receipts, a local-first (file/SQLite) → cloud Postgres path, scoped credentials and row-level security. Those claims are the author's own and I haven't independently verified LoopX; but the design lessons are exactly the gaps visible when you combine Board and Buzz, so the combined v2 adopts them as architecture.
        </p>
      </Card>

      <Card className="p-5">
        <div className="mb-2 text-sm font-semibold text-white">Sources</div>
        <ul className="grid gap-1.5 text-xs text-zinc-400 md:grid-cols-2">
          {[
            ["Vercel — Introducing Vercel Board", "https://vercel.com/blog/introducing-vercel-board"],
            ["block/buzz repository README", "https://github.com/block/buzz"],
            ["Buzz coverage — Runtime Wire", "https://runtimewire.com/article/jack-dorsey-block-buzz-team-chat-ai-agents-git"],
            ["Buzz coverage — explainx.ai", "https://www.explainx.ai/blog/jack-dorsey-block-buzz-ai-agents-team-chat-git-2026"],
            ["Board coverage — GazeWire", "https://gazewire.com/technology-innovation/ai-and-automation/vercel-s-board-gives-claude-code-and-codex-agents-a-shared-task-board"],
            ["Post on LoopX / Projection ≠ Authority (X)", "https://x.com/huangruiteng/status/2125078072387088707"],
          ].map(([t, u]) => (
            <li key={u}><a className="inline-flex items-center gap-1.5 hover:text-white" href={u} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t}</a></li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
