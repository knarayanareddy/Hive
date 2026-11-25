import { ArrowRight, GitCompare, Hammer, Network, PlayCircle, Zap } from "lucide-react";
import { Badge, Card } from "../components/ui";
import type { PageId } from "../App";

const NAV: { id: PageId; icon: typeof Zap; title: string; text: string; tone: string }[] = [
  { id: "compare", icon: GitCompare, title: "Compare & contrast", text: "16-row matrix, capability radar, what to keep from each, where the plain union breaks.", tone: "text-violet-300" },
  { id: "board", icon: Zap, title: "Board prototype", text: "Channels, tasks, leases, watchers, grants, schemas — driven by a working `vercel board` CLI.", tone: "text-white" },
  { id: "buzz", icon: Zap, title: "Buzz prototype", text: "Signed events, attestations, branch rooms, YAML workflows, search and a tamper-evident audit chain.", tone: "text-amber-300" },
  { id: "combined", icon: PlayCircle, title: "Before / After prototype", text: "Same scenario, same faults, run side by side: naive union vs hardened Hive. You approve the gate.", tone: "text-emerald-300" },
  { id: "diagrams", icon: Network, title: "Architecture diagrams", text: "Five interactive diagrams with animated flows, node inspectors and weak-point markers.", tone: "text-sky-300" },
  { id: "guide", icon: Hammer, title: "Build guide", text: "Principles, data model, protocol, 7 core algorithms, phased rollout and a build-brief generator.", tone: "text-orange-300" },
];

export default function Overview({ go }: { go: (p: PageId) => void }) {
  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-950 to-black p-8 sm:p-12">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-amber-400/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 left-1/3 h-96 w-96 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone="white">Vercel Board</Badge>
            <Badge tone="amber">Buzz by Block</Badge>
            <Badge tone="emerald">Hive · combined</Badge>
          </div>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-6xl">
            Where humans and agents <span className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-transparent">share a room</span> — and who keeps it honest.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-zinc-400">
            Two launches, two philosophies. <b className="text-zinc-200">Vercel Board</b> is a headless coordination primitive: tasks, leases, watchers. <b className="text-zinc-200">Buzz</b> is a signed-event workspace: identity, forge, workflows. This site compares them, prototypes both with mock data, designs a combined system, shows it failing and then surviving, and hands you the build plan.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button onClick={() => go("hive")} className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-black hover:bg-emerald-300">
              <Zap size={17} /> Open Live Hive Workspace
            </button>
            <button onClick={() => go("combined")} className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-3 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/20">
              <PlayCircle size={17} /> Watch Before vs After
            </button>
            <button onClick={() => go("compare")} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800">
              Read the comparison <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["The shared bet", "Agents need a durable shared place — tasks, context and results — instead of a Markdown file or an improvised Slack channel. Both products are harness-agnostic and treat agents as first-class participants."],
          ["Where they differ", "Board plugs into Slack/GitHub/Linear and excels at task claiming, leases and wake-ups. Buzz replaces those tools with one relay, signs every action, and makes a branch a room. One is a primitive, the other a platform."],
          ["Where both stop short", "Neither prevents a stale agent from writing, a guest's message from steering an agent, an unverified “done”, or an unapproved merge. Chat is still the authority. That's what the combined v2 fixes."],
        ].map(([t, d]) => (
          <Card key={t} className="p-5">
            <div className="text-sm font-semibold text-white">{t}</div>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{d}</p>
          </Card>
        ))}
      </section>

      <section>
        <div className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">What's inside</div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => go(n.id)} className="group rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-left transition hover:border-zinc-600 hover:bg-zinc-900">
              <n.icon className={n.tone} size={20} />
              <div className="mt-3 flex items-center gap-2 text-base font-semibold text-white">{n.title}<ArrowRight size={15} className="translate-x-0 text-zinc-600 transition group-hover:translate-x-1 group-hover:text-white" /></div>
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">{n.text}</p>
            </button>
          ))}
        </div>
      </section>

      <p className="text-xs leading-relaxed text-zinc-600">
        Everything here runs on mock data in your browser — no network calls to Vercel, Block or Slack. Product facts come from public launch posts and docs; the combined “Hive” design, scores and failure scenarios are my own proposals, not features of either product. Hash/“signature” values are demo-grade, not cryptography.
      </p>
    </div>
  );
}
