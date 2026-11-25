import { useState } from "react";
import ArchDiagram from "./ArchDiagram";
import { DIAGRAMS, v1Diagram, v2Diagram } from "./diagramData";
import { Badge, Card, SectionTitle, Tabs } from "../components/ui";
import { ArrowRight } from "lucide-react";

const FIXES: { weak: string; where: string; fix: string; node: string }[] = [
  { weak: "Chat log is the authority (“done” = someone said done)", where: "Relay: signed events", fix: "Authority kernel owns state; chat is a projection", node: "Authority kernel" },
  { weak: "Advisory lease; zombie writers accepted", where: "Tasks as threads", fix: "Lease + fencing epoch checked on every CAS write", node: "Lease + fencing" },
  { weak: "Agent reads any message as instruction", where: "Two-way sync / Agents", fix: "Ingest trust labels + capability tokens + DLP", node: "Ingest · Gateway · Policy" },
  { weak: "Approval gates not enforced", where: "Workflows + watchers", fix: "Merge is a command that needs a SHA-bound approval receipt", node: "Approval gates" },
  { weak: "Agent's word closes a task", where: "Tasks as threads", fix: "Independent verifier issues a VerifiedClose receipt", node: "Independent verifier" },
  { weak: "Duplicate side effects on retry", where: "Agents / CLI", fix: "Idempotent outbox with keys and read-back receipts", node: "Idempotent outbox" },
  { weak: "No spend or loop protection", where: "Agents", fix: "Budget + circuit breaker, deterministic /resume", node: "Budget + breaker · /commands" },
  { weak: "Long-lived agent processes or prompt-memory renewals", where: "Workflows + watchers", fix: "Sleeping agents with an unread wake queue; hook-driven renewal", node: "Wake queue + scheduler" },
];

export default function DiagramsPage() {
  const [id, setId] = useState(DIAGRAMS[0].id);
  const d = DIAGRAMS.find((x) => x.id === id)!;
  return (
    <div className="space-y-5">
      <SectionTitle
        eyebrow="Interactive architecture"
        title="Workflow architecture diagrams"
        sub="Five live diagrams. Click nodes to inspect them, filter by origin (Board / Buzz / new), and play animated flows to watch a request travel through each system. Red “!” markers are known weak points; green NEW badges are the additions in the combined design."
      />
      <Tabs
        value={id}
        onChange={setId}
        accent="emerald"
        tabs={[
          { id: "board", label: "1 · Vercel Board" },
          { id: "buzz", label: "2 · Buzz" },
          { id: "v1", label: "3 · Combined v1 (before)" },
          { id: "v2", label: "4 · Combined v2 “Hive” (after)" },
          { id: "life", label: "5 · Task lifecycle" },
        ]}
      />
      <Card className="p-4 sm:p-5">
        <div className="mb-3">
          <h3 className="text-lg font-semibold text-white">{d.title}</h3>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">{d.blurb}</p>
        </div>
        <ArchDiagram diagram={d} />
      </Card>

      {(id === "v1" || id === "v2") && (
        <Card className="p-5">
          <div className="mb-1 text-sm font-semibold text-white">What changed between v1 and v2</div>
          <p className="mb-4 text-xs text-zinc-500">
            {v1Diagram.nodes.filter((n) => n.risk).length} weak points in v1 → {v2Diagram.nodes.filter((n) => n.origin === "new").length} new components in v2.
          </p>
          <div className="grid gap-2">
            {FIXES.map((f) => (
              <div key={f.weak} className="grid items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs md:grid-cols-[1fr_auto_1fr_auto]">
                <div className="text-rose-200">⚠ {f.weak}<div className="text-[10px] text-zinc-500">in: {f.where}</div></div>
                <ArrowRight size={14} className="hidden text-zinc-600 md:block" />
                <div className="text-emerald-200">✓ {f.fix}</div>
                <Badge tone="emerald">{f.node}</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
