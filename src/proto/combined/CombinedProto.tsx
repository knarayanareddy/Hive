import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  ChevronsRight,
  Cpu,
  Pause,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  User,
  X,
  Sparkles,
  Skull,
  Smile,
} from "lucide-react";
import { Badge, Btn, Card, Tabs } from "../../components/ui";
import { Github, Slack } from "../../components/brand";
import ArchDiagram from "../../diagrams/ArchDiagram";
import { v1Diagram, v2Diagram } from "../../diagrams/diagramData";
import { cn } from "../../utils/cn";
import { FAULT_META, buildRun, fresh, scoreboard, type Faults, type Lane, type Mode, type Snap, type Step, type StepTone } from "./engine";

const LANE_ICON: Record<Lane, ReactNode> = {
  slack: <Slack size={13} />,
  kernel: <Cpu size={13} />,
  agent: <Bot size={13} />,
  verifier: <ShieldCheck size={13} />,
  human: <User size={13} />,
  github: <Github size={13} />,
  relay: <Radio size={13} />,
};

const TONE: Record<StepTone, string> = {
  info: "border-zinc-600 bg-zinc-900/60",
  ok: "border-sky-500/50 bg-sky-500/5",
  good: "border-emerald-500/60 bg-emerald-500/10",
  warn: "border-amber-500/60 bg-amber-500/10",
  bad: "border-rose-500/70 bg-rose-500/10",
  pending: "border-violet-400/70 bg-violet-500/10",
};

const NONE: Faults = { inject: false, stall: false, crash: false, runaway: false, falseFix: false, gate: false };
const ALL: Faults = { inject: true, stall: true, crash: true, runaway: true, falseFix: true, gate: true };

export default function CombinedProto() {
  const [faults, setFaults] = useState<Faults>({ inject: true, stall: true, crash: false, runaway: false, falseFix: true, gate: true });
  const [view, setView] = useState<"split" | "v1" | "v2">("split");
  const [n1, setN1] = useState(0);
  const [n2, setN2] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject" | undefined>();
  const [showDiagram, setShowDiagram] = useState(false);

  const steps1 = useMemo(() => buildRun("v1", faults), [faults]);
  const steps2 = useMemo(() => buildRun("v2", faults, decision), [faults, decision]);

  const reset = () => {
    setN1(0);
    setN2(0);
    setPlaying(false);
    setDecision(undefined);
  };
  const setF = (f: Faults) => {
    setFaults(f);
    reset();
  };

  const awaiting = !decision && steps2[steps2.length - 1]?.pending === "approval" && n2 >= steps2.length;
  const done1 = n1 >= steps1.length;
  const done2 = n2 >= steps2.length;
  const finished = done1 && done2 && !awaiting;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setN1((x) => Math.min(steps1.length, x + 1));
      setN2((x) => Math.min(steps2.length, x + 1));
    }, 1100);
    return () => clearInterval(id);
  }, [playing, steps1.length, steps2.length]);

  useEffect(() => {
    if (playing && done1 && done2 && !awaiting) setPlaying(false);
  }, [playing, done1, done2, awaiting]);

  const stepOnce = () => {
    setN1((x) => Math.min(steps1.length, x + 1));
    setN2((x) => Math.min(steps2.length, x + 1));
  };
  const runAll = () => {
    setN1(steps1.length);
    setN2(steps2.length);
    setPlaying(false);
  };

  const snap1 = n1 ? steps1[n1 - 1].snap : fresh();
  const snap2 = n2 ? steps2[n2 - 1].snap : fresh();
  const metrics = scoreboard(snap1, snap2);
  const active = Object.values(faults).filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* fault panel */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-white">Scenario: “Customer bug in Slack → fixed in production”</div>
          <Badge tone="violet">{active} fault{active === 1 ? "" : "s"} injected</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <Btn size="sm" onClick={() => setF(NONE)}><Smile size={13} /> Happy path</Btn>
            <Btn size="sm" onClick={() => setF({ inject: true, stall: true, crash: false, runaway: false, falseFix: true, gate: true })}><Sparkles size={13} /> Demo mix</Btn>
            <Btn size="sm" onClick={() => setF(ALL)}><Skull size={13} /> Total chaos</Btn>
          </div>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Both prototypes run the identical scenario with the identical faults. Toggle faults to see which design survives them. In v2, the approval gate genuinely pauses for <i>your</i> decision.</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {FAULT_META.map((f) => (
            <label key={f.id} className={cn("cursor-pointer rounded-lg border p-3 transition", faults[f.id] ? "border-rose-500/40 bg-rose-500/5" : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700")}>
              <div className="flex items-start gap-2">
                <input type="checkbox" checked={faults[f.id]} onChange={() => setF({ ...faults, [f.id]: !faults[f.id] })} className="mt-0.5 accent-rose-500" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-zinc-100">{f.title}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{f.short}</div>
                  <div className="mt-1.5 text-[11px] leading-snug text-rose-300/80">v1: {f.hurts}</div>
                  <div className="text-[11px] leading-snug text-emerald-300/90">v2: {f.fixes}</div>
                </div>
              </div>
            </label>
          ))}
        </div>
      </Card>

      {/* controls */}
      <div className="sticky top-14 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/90 p-2.5 backdrop-blur">
        <Btn variant="success" onClick={() => (finished ? (reset(), setPlaying(true)) : setPlaying((p) => !p))}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
          {playing ? "Pause" : finished ? "Replay" : n1 === 0 && n2 === 0 ? "Run both" : "Resume"}
        </Btn>
        <Btn onClick={stepOnce} disabled={finished}><SkipForward size={15} /> Step</Btn>
        <Btn onClick={runAll}><ChevronsRight size={15} /> Run to end</Btn>
        <Btn variant="ghost" onClick={reset}><RotateCcw size={14} /> Reset</Btn>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={showDiagram} onChange={(e) => setShowDiagram(e.target.checked)} className="accent-emerald-400" /> live architecture
          </label>
          <Tabs size="sm" value={view} onChange={setView} accent="emerald" tabs={[{ id: "split", label: "Before | After" }, { id: "v1", label: "Before" }, { id: "v2", label: "After" }]} />
        </div>
      </div>

      {awaiting && (
        <div className="fadeup rounded-xl border border-violet-400/60 bg-violet-500/10 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <ShieldCheck className="text-violet-300" />
            <div className="min-w-[240px] flex-1">
              <div className="text-sm font-semibold text-white">v2 is paused: human approval required for payments/*</div>
              <div className="text-xs text-zinc-400">Merge is blocked by the kernel until a receipt bound to head SHA 3fa9c1 exists. v1 already merged without asking.</div>
            </div>
            <Btn variant="success" onClick={() => setDecision("approve")}><Check size={15} /> /approve 801</Btn>
            <Btn variant="danger" onClick={() => setDecision("reject")}><X size={15} /> /reject 801</Btn>
          </div>
        </div>
      )}

      <div className={cn("grid gap-4", view === "split" && "xl:grid-cols-2")}>
        {(view === "split" || view === "v1") && (
          <Column mode="v1" steps={steps1} n={n1} snap={snap1} showDiagram={showDiagram} />
        )}
        {(view === "split" || view === "v2") && (
          <Column mode="v2" steps={steps2} n={n2} snap={snap2} showDiagram={showDiagram} />
        )}
      </div>

      {/* scoreboard */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-semibold text-white">Outcome scoreboard</div>
          <span className="text-xs text-zinc-500">live — updates as each prototype progresses{finished ? " · final" : ""}</span>
        </div>
        <div className="grid divide-y divide-zinc-800 md:grid-cols-2 md:divide-x md:divide-y-0 lg:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.label} className="border-zinc-800 p-4 lg:border-b">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{m.label}</div>
              <div className="mt-1.5 flex items-end gap-4">
                <div>
                  <div className={cn("text-xl font-semibold tabular-nums", m.better === "v2" ? "text-rose-300" : "text-zinc-200")}>{m.v1}</div>
                  <div className="text-[10px] text-zinc-600">before</div>
                </div>
                <div className="pb-1 text-zinc-700">→</div>
                <div>
                  <div className={cn("text-xl font-semibold tabular-nums", m.better === "v1" ? "text-rose-300" : "text-emerald-300")}>{m.v2}</div>
                  <div className="text-[10px] text-zinc-600">after</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        {finished && (
          <div className="border-t border-zinc-800 p-4 text-sm">
            <Verdict s1={snap1} s2={snap2} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Verdict({ s1, s2 }: { s1: Snap; s2: Snap }) {
  const bad1 = +s1.leaked + Math.max(0, s1.prs - 1) + s1.stale + +s1.unverified + +s1.unapproved + (s1.spend > 10 ? 1 : 0);
  const bad2 = +s2.leaked + Math.max(0, s2.prs - 1) + s2.stale + +s2.unverified + +s2.unapproved + (s2.spend > 10 ? 1 : 0);
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Badge tone={bad1 ? "rose" : "emerald"}>Before: {bad1} incident{bad1 === 1 ? "" : "s"}</Badge>
      <Badge tone={bad2 ? "rose" : "emerald"}>After: {bad2} incident{bad2 === 1 ? "" : "s"}</Badge>
      <p className="min-w-[260px] flex-1 text-xs leading-relaxed text-zinc-400">
        {s2.blocked && !s2.closed
          ? "v2 deliberately stopped: the merge stayed blocked after your rejection, and the task re-entered the queue with feedback."
          : bad1 === 0
            ? "With few or no faults both designs reach the same result — the combined v1 is a perfectly good happy-path system. The difference only shows when something goes wrong."
            : `Same agents, same bug, same faults. v1 shipped with ${bad1} incident${bad1 === 1 ? "" : "s"}; v2 turned each into a rejected write, a quarantined message, a halted loop or a human decision — at the cost of ${s2.humanTouches} deliberate human touch${s2.humanTouches === 1 ? "" : "es"} and a few extra control-plane hops.`}
      </p>
    </div>
  );
}

function Column({ mode, steps, n, snap, showDiagram }: { mode: Mode; steps: Step[]; n: number; snap: Snap; showDiagram: boolean }) {
  const v2 = mode === "v2";
  const shown = steps.slice(0, n);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: 1e6, behavior: "smooth" });
  }, [n]);
  const last = shown[shown.length - 1];
  return (
    <Card className={cn("flex flex-col overflow-hidden", v2 ? "border-emerald-500/30" : "border-orange-500/30")}>
      <div className={cn("flex items-center gap-2 border-b px-4 py-3", v2 ? "border-emerald-500/20 bg-emerald-500/5" : "border-orange-500/20 bg-orange-500/5")}>
        <Badge tone={v2 ? "emerald" : "orange"}>{v2 ? "AFTER" : "BEFORE"}</Badge>
        <div className="text-sm font-semibold text-white">{v2 ? "Combined v2 · Hive (hardened)" : "Combined v1 · naive union"}</div>
        <div className="ml-auto text-xs text-zinc-500">{n}/{steps.length}{v2 && steps[steps.length - 1]?.pending && n >= steps.length ? " · waiting for you" : ""}</div>
      </div>

      {/* state card */}
      <div className="grid grid-cols-2 gap-px bg-zinc-800 text-[11px] sm:grid-cols-4">
        {[
          ["Task", snap.task],
          ["Owner", snap.owner],
          ["Lease", v2 ? snap.lease : snap.lease === "—" ? "—" : snap.lease],
          ["PRs open", String(snap.prs)],
          ["Spend", snap.spend ? `$${snap.spend.toFixed(2)}${snap.cap ? ` / $${snap.cap}` : ""}` : "—"],
          ["Approved by", snap.approvedBy ?? "—"],
          ["Fenced / quarantined", v2 ? `${snap.fenced} / ${snap.quarantined}` : "n/a"],
          ["Evidence", snap.evidence.length ? snap.evidence.join(", ") : "—"],
        ].map(([k, v]) => (
          <div key={k} className="bg-zinc-950 px-3 py-2">
            <div className="text-zinc-600">{k}</div>
            <div className="truncate font-medium text-zinc-200" title={v}>{v}</div>
          </div>
        ))}
      </div>

      {showDiagram && (
        <div className="border-b border-zinc-800 p-3">
          <ArchDiagram diagram={v2 ? v2Diagram : v1Diagram} compact highlight={last?.node ?? null} highlightTone={v2 ? "emerald" : "amber"} />
        </div>
      )}

      <div ref={box} className="max-h-[560px] min-h-[260px] flex-1 space-y-2.5 overflow-y-auto p-4">
        {shown.length === 0 && <div className="grid h-52 place-items-center text-center text-sm text-zinc-600">Press “Run both” to start the scenario.<br />Faults selected above will fire along the way.</div>}
        {shown.map((s) => (
          <div key={s.id} className={cn("fadeup rounded-lg border-l-4 border p-3", TONE[s.tone], s.tone === "pending" && "animate-pulse")}>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
              <span className="font-mono text-zinc-500">{s.t}</span>
              <span className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{LANE_ICON[s.lane]} {s.actor}</span>
              {s.mech && <Badge tone="emerald">{s.mech}</Badge>}
              {s.tone === "bad" && <Badge tone="rose">incident</Badge>}
              {s.tone === "warn" && <Badge tone="amber">fault</Badge>}
            </div>
            <div className="mt-1 text-[13px] font-medium leading-snug text-white">{s.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-400">{s.detail}</div>
            {s.cmd && <code className="mt-1.5 inline-block rounded bg-black/50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">$ {s.cmd}</code>}
          </div>
        ))}
      </div>
    </Card>
  );
}

