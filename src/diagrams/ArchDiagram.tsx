import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, AlertTriangle } from "lucide-react";
import { Badge, Btn, type Tone } from "../components/ui";
import { cn } from "../utils/cn";

export type Origin = "board" | "buzz" | "both" | "new" | "external" | "neutral";

export interface DNode {
  id: string;
  label: string;
  sub?: string;
  col: number;
  row: number;
  origin: Origin;
  emoji?: string;
  risk?: string;
  detail: { what: string; how?: string; limits?: string[]; ex?: string };
}
export interface DEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}
export interface DFlowStep {
  from: string;
  to: string;
  label: string;
}
export interface DFlow {
  id: string;
  name: string;
  desc: string;
  steps: DFlowStep[];
}
export interface DGroup {
  label: string;
  nodes: string[];
  tone?: "white" | "amber" | "emerald" | "zinc";
}
export interface Diagram {
  id: string;
  title: string;
  blurb: string;
  nodes: DNode[];
  edges: DEdge[];
  flows: DFlow[];
  groups?: DGroup[];
  showLabels?: boolean;
  legend: Origin[];
}

const NW = 142;
const NH = 62;
const CW = 176;
const RH = 96;
const PX = 24;
const PY = 38;

export const ORIGIN_META: Record<Origin, { label: string; stroke: string; fill: string; text: string; tone: Tone }> = {
  board: { label: "Vercel Board", stroke: "#e4e4e7", fill: "#18181b", text: "#fafafa", tone: "white" },
  buzz: { label: "Buzz", stroke: "#fbbf24", fill: "#2a2108", text: "#fde68a", tone: "amber" },
  both: { label: "Both / shared idea", stroke: "#a78bfa", fill: "#1d1633", text: "#ddd6fe", tone: "violet" },
  new: { label: "New in the combination", stroke: "#34d399", fill: "#06241b", text: "#a7f3d0", tone: "emerald" },
  external: { label: "External system", stroke: "#71717a", fill: "#0f0f12", text: "#d4d4d8", tone: "zinc" },
  neutral: { label: "Component", stroke: "#52525b", fill: "#18181b", text: "#e4e4e7", tone: "zinc" },
};

function pos(n: DNode) {
  return { x: PX + n.col * CW, y: PY + n.row * RH };
}

function pathBetween(a: DNode, b: DNode) {
  const pa = pos(a);
  const pb = pos(b);
  if (a.col === b.col) {
    const down = b.row > a.row;
    const x1 = pa.x + NW / 2;
    const y1 = pa.y + (down ? NH : 0);
    const x2 = pb.x + NW / 2;
    const y2 = pb.y + (down ? 0 : NH);
    const my = (y1 + y2) / 2;
    return { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, mx: (x1 + x2) / 2, my };
  }
  const right = b.col > a.col;
  const x1 = pa.x + (right ? NW : 0);
  const y1 = pa.y + NH / 2;
  const x2 = pb.x + (right ? 0 : NW);
  const y2 = pb.y + NH / 2;
  const mx = (x1 + x2) / 2;
  return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, mx, my: (y1 + y2) / 2 };
}

export default function ArchDiagram({
  diagram,
  compact = false,
  highlight,
  highlightTone = "emerald",
}: {
  diagram: Diagram;
  compact?: boolean;
  highlight?: string | null;
  highlightTone?: "emerald" | "amber" | "rose";
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [filter, setFilter] = useState<Origin | null>(null);

  useEffect(() => {
    setSel(null);
    setFlowId(null);
    setStep(0);
    setPlaying(false);
    setFilter(null);
  }, [diagram.id]);

  const flow = diagram.flows.find((f) => f.id === flowId) ?? null;
  useEffect(() => {
    if (!playing || !flow) return;
    const id = setInterval(() => {
      setStep((s) => {
        if (s >= flow.steps.length - 1) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 1500);
    return () => clearInterval(id);
  }, [playing, flow]);

  const byId = useMemo(() => Object.fromEntries(diagram.nodes.map((n) => [n.id, n])), [diagram]);
  const maxCol = Math.max(...diagram.nodes.map((n) => n.col));
  const maxRow = Math.max(...diagram.nodes.map((n) => n.row));
  const W = PX * 2 + maxCol * CW + NW;
  const H = PY + maxRow * RH + NH + 28;

  const cur = flow ? flow.steps[Math.min(step, flow.steps.length - 1)] : null;
  const activeNodes = new Set<string>();
  if (cur) {
    activeNodes.add(cur.from);
    activeNodes.add(cur.to);
  }
  if (highlight) activeNodes.add(highlight);
  const selEdges = sel ? diagram.edges.filter((e) => e.from === sel || e.to === sel) : [];
  const connected = new Set<string>(sel ? [sel] : []);
  selEdges.forEach((e) => {
    connected.add(e.from);
    connected.add(e.to);
  });
  const hl = { emerald: "#34d399", amber: "#fbbf24", rose: "#fb7185" }[highlightTone];
  const selNode = sel ? byId[sel] : null;

  const dimNode = (n: DNode) => {
    if (filter && n.origin !== filter) return true;
    if (sel && !connected.has(n.id)) return true;
    if (cur && !activeNodes.has(n.id)) return true;
    return false;
  };

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          {diagram.legend.map((o) => (
            <button
              key={o}
              onClick={() => setFilter((f) => (f === o ? null : o))}
              className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition", filter === o ? "border-white/60 bg-white/10 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600")}
            >
              <span className="h-2.5 w-2.5 rounded-sm border" style={{ background: ORIGIN_META[o].fill, borderColor: ORIGIN_META[o].stroke }} />
              {ORIGIN_META[o].label}
            </button>
          ))}
          <span className="flex items-center gap-1 text-[11px] text-rose-300"><AlertTriangle size={12} /> = known weak point</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.05)_1px,transparent_0)] [background-size:22px_22px]">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: compact ? 640 : 900 }} className="block w-full">
          <defs>
            <marker id={`arr-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#71717a" />
            </marker>
            <marker id={`arrh-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#fff" />
            </marker>
          </defs>

          {/* groups */}
          {diagram.groups?.map((g) => {
            const ns = g.nodes.map((id) => byId[id]).filter(Boolean);
            if (!ns.length) return null;
            const xs = ns.map((n) => pos(n).x);
            const ys = ns.map((n) => pos(n).y);
            const x = Math.min(...xs) - 12;
            const y = Math.min(...ys) - 22;
            const w = Math.max(...xs) + NW + 12 - x;
            const h = Math.max(...ys) + NH + 12 - y;
            const c = { white: "#ffffff", amber: "#fbbf24", emerald: "#34d399", zinc: "#a1a1aa" }[g.tone ?? "zinc"];
            return (
              <g key={g.label}>
                <rect x={x} y={y} width={w} height={h} rx={14} fill={c} fillOpacity={0.035} stroke={c} strokeOpacity={0.25} strokeDasharray="5 5" />
                <text x={x + 10} y={y + 13} fontSize={10} fontWeight={600} fill={c} fillOpacity={0.75} letterSpacing={1.2}>
                  {g.label.toUpperCase()}
                </text>
              </g>
            );
          })}

          {/* edges */}
          {diagram.edges.map((e, i) => {
            const a = byId[e.from];
            const b = byId[e.to];
            if (!a || !b) return null;
            const p = pathBetween(a, b);
            const isSel = selEdges.includes(e);
            const isCur = !!cur && ((cur.from === e.from && cur.to === e.to) || (cur.from === e.to && cur.to === e.from));
            const dim = (sel && !isSel) || (cur && !isCur) || (filter && a.origin !== filter && b.origin !== filter);
            return (
              <g key={i} opacity={dim ? 0.12 : 1}>
                <path d={p.d} fill="none" stroke={isCur || isSel ? "#fff" : "#52525b"} strokeWidth={isCur ? 2.2 : isSel ? 1.8 : 1.2} strokeDasharray={e.dashed ? "4 4" : undefined} markerEnd={`url(#${isCur || isSel ? "arrh-" : "arr-"}${diagram.id})`} />
                {(diagram.showLabels || isSel) && e.label && (
                  <text x={p.mx} y={p.my - 5} fontSize={9} fill="#d4d4d8" textAnchor="middle" stroke="#09090b" strokeWidth={3} paintOrder="stroke">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* flow step path + packet */}
          {cur && byId[cur.from] && byId[cur.to] && (() => {
            const p = pathBetween(byId[cur.from], byId[cur.to]);
            return (
              <g key={`${flowId}-${step}`}>
                <path d={p.d} fill="none" stroke="#fbbf24" strokeWidth={2.6} strokeDasharray="7 5" style={{ animation: "dashmove 0.7s linear infinite" }} />
                <circle r={6} fill="#fbbf24" stroke="#000" strokeWidth={1.5}>
                  <animateMotion dur="1.1s" repeatCount="indefinite" path={p.d} />
                </circle>
                <text x={p.mx} y={p.my - 10} fontSize={11} fontWeight={600} fill="#fde68a" textAnchor="middle" stroke="#09090b" strokeWidth={4} paintOrder="stroke">
                  {cur.label}
                </text>
              </g>
            );
          })()}

          {/* nodes */}
          {diagram.nodes.map((n) => {
            const { x, y } = pos(n);
            const m = ORIGIN_META[n.origin];
            const active = activeNodes.has(n.id);
            const hlThis = highlight === n.id;
            return (
              <g key={n.id} opacity={dimNode(n) ? 0.25 : 1} style={{ cursor: "pointer", transition: "opacity .25s" }} onClick={() => !compact && setSel((s) => (s === n.id ? null : n.id))}>
                {active && <rect x={x - 5} y={y - 5} width={NW + 10} height={NH + 10} rx={15} fill="none" stroke={hlThis ? hl : "#fbbf24"} strokeWidth={2} style={{ animation: "pulseglow 1.2s ease-in-out infinite" }} />}
                <rect x={x} y={y} width={NW} height={NH} rx={11} fill={m.fill} stroke={sel === n.id ? "#fff" : m.stroke} strokeWidth={sel === n.id ? 2.4 : 1.4} strokeDasharray={n.origin === "external" ? "5 4" : undefined} />
                <foreignObject x={x + 6} y={y + 4} width={NW - 12} height={NH - 8}>
                  <div style={{ color: m.text }} className="flex h-full flex-col justify-center leading-tight">
                    <div className="text-[11.5px] font-semibold">
                      {n.emoji && <span className="mr-1">{n.emoji}</span>}
                      {n.label}
                    </div>
                    {n.sub && <div className="mt-0.5 text-[9.5px] opacity-65">{n.sub}</div>}
                  </div>
                </foreignObject>
                {n.risk && (
                  <g>
                    <circle cx={x + NW - 4} cy={y + 4} r={8} fill="#e11d48" stroke="#09090b" strokeWidth={2} />
                    <text x={x + NW - 4} y={y + 8} fontSize={11} fontWeight={800} fill="#fff" textAnchor="middle">!</text>
                  </g>
                )}
                {n.origin === "new" && !compact && (
                  <g>
                    <rect x={x + NW - 30} y={y - 8} width={28} height={13} rx={6} fill="#34d399" />
                    <text x={x + NW - 16} y={y + 2} fontSize={8} fontWeight={800} fill="#022c22" textAnchor="middle">NEW</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {!compact && (
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
          {/* flows */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Animated flows</div>
            <div className="mb-3 flex flex-wrap gap-2">
              {diagram.flows.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setFlowId(f.id === flowId ? null : f.id);
                    setStep(0);
                    setPlaying(f.id !== flowId);
                    setSel(null);
                  }}
                  className={cn("rounded-lg border px-3 py-1.5 text-xs font-medium transition", flowId === f.id ? "border-amber-400 bg-amber-400/15 text-amber-200" : "border-zinc-700 text-zinc-300 hover:border-zinc-500")}
                >
                  {f.name}
                </button>
              ))}
            </div>
            {flow && cur ? (
              <div>
                <p className="mb-2 text-xs text-zinc-400">{flow.desc}</p>
                <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-amber-300">Step {step + 1} / {flow.steps.length}</div>
                  <div className="mt-0.5 text-sm font-medium text-white">{cur.label}</div>
                  <div className="mt-1 text-xs text-zinc-400">{byId[cur.from]?.label} → {byId[cur.to]?.label}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Btn size="sm" onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }}><ChevronLeft size={14} /></Btn>
                  <Btn size="sm" variant="amber" onClick={() => { if (step >= flow.steps.length - 1) setStep(0); setPlaying((p) => !p); }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "Pause" : "Play"}</Btn>
                  <Btn size="sm" onClick={() => { setPlaying(false); setStep((s) => Math.min(flow.steps.length - 1, s + 1)); }}><ChevronRight size={14} /></Btn>
                  <Btn size="sm" variant="ghost" onClick={() => { setStep(0); setPlaying(false); }}><RotateCcw size={13} /></Btn>
                  <div className="ml-2 flex flex-1 gap-1">
                    {flow.steps.map((_, i) => (
                      <button key={i} onClick={() => { setStep(i); setPlaying(false); }} className={cn("h-1.5 flex-1 rounded-full", i <= step ? "bg-amber-400" : "bg-zinc-700")} />
                    ))}
                  </div>
                </div>
                <ol className="mt-3 max-h-40 space-y-1 overflow-y-auto text-[11px] text-zinc-500">
                  {flow.steps.map((s, i) => (
                    <li key={i} onClick={() => { setStep(i); setPlaying(false); }} className={cn("cursor-pointer rounded px-1.5 py-0.5", i === step ? "bg-zinc-800 text-zinc-200" : "hover:text-zinc-300")}>
                      {i + 1}. {s.label}
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">Pick a flow to watch a request travel through the architecture, step by step. Or click any node to inspect it.</p>
            )}
          </div>

          {/* node detail */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Node inspector</div>
            {selNode ? (
              <div className="space-y-2 text-xs leading-relaxed text-zinc-300">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-white">{selNode.emoji} {selNode.label}</span>
                  <Badge tone={ORIGIN_META[selNode.origin].tone}>{ORIGIN_META[selNode.origin].label}</Badge>
                </div>
                <p>{selNode.detail.what}</p>
                {selNode.detail.how && <p className="text-zinc-400"><b className="text-zinc-300">How:</b> {selNode.detail.how}</p>}
                {selNode.detail.ex && <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-black/50 p-2 text-[11px] text-emerald-300">{selNode.detail.ex}</pre>}
                {selNode.risk && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-200"><b>⚠ Weak point:</b> {selNode.risk}</div>}
                {selNode.detail.limits && (
                  <ul className="list-disc space-y-0.5 pl-4 text-zinc-400">
                    {selNode.detail.limits.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                )}
                <div className="pt-1 text-[11px] text-zinc-500">Connected to: {selEdges.map((e) => byId[e.from === selNode.id ? e.to : e.from]?.label).join(" · ") || "—"}</div>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">Click a node to see what it does, how it works, its limits and which components it talks to. Edges and neighbours stay lit; the rest dims.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
