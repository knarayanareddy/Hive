import { useEffect, useState } from "react";
import { Cpu, GitCompare, Hammer, Home, Network, PlayCircle } from "lucide-react";
import Overview from "./pages/Overview";
import Compare from "./pages/Compare";
import Guide from "./pages/Guide";
import BoardProto from "./proto/BoardProto";
import BuzzProto from "./proto/BuzzProto";
import CombinedProto from "./proto/combined/CombinedProto";
import DiagramsPage from "./diagrams/DiagramsPage";
import LiveHivePage from "./web/LiveHivePage";
import { SectionTitle } from "./components/ui";
import { cn } from "./utils/cn";

export type PageId =
  | "hive"
  | "overview"
  | "compare"
  | "board"
  | "buzz"
  | "combined"
  | "diagrams"
  | "guide";

const NAV: { id: PageId; label: string; icon?: typeof Home; dot?: string }[] = [
  { id: "hive", label: "Live Hive", icon: Cpu },
  { id: "overview", label: "Overview", icon: Home },
  { id: "compare", label: "Compare", icon: GitCompare },
  { id: "board", label: "Board", dot: "bg-white" },
  { id: "buzz", label: "Buzz", dot: "bg-amber-400" },
  { id: "combined", label: "Before / After", icon: PlayCircle },
  { id: "diagrams", label: "Diagrams", icon: Network },
  { id: "guide", label: "Build guide", icon: Hammer },
];

const valid = (h: string): h is PageId => NAV.some((n) => n.id === h);

export default function App() {
  const [page, setPage] = useState<PageId>(() => {
    const h = window.location.hash.replace("#", "");
    return valid(h) ? h : "hive";
  });
  const go = (p: PageId) => {
    setPage(p);
    window.location.hash = p;
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const on = () => {
      const h = window.location.hash.replace("#", "");
      if (valid(h)) setPage(h);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-4 px-4">
          <button
            onClick={() => go("hive")}
            className="flex items-center gap-2 text-sm font-semibold text-white"
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-amber-300 to-emerald-400 text-sm text-black">
              ⬡
            </span>
            <span className="hidden sm:inline">Hive · Board × Buzz</span>
          </button>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => go(n.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  page === n.id
                    ? n.id === "hive"
                      ? "bg-emerald-400 text-black"
                      : "bg-white/10 text-white"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-white",
                )}
              >
                {n.icon ? (
                  <n.icon size={14} />
                ) : (
                  <span className={cn("h-2 w-2 rounded-full", n.dot)} />
                )}
                {n.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-8">
        {page === "hive" && <LiveHivePage />}
        {page === "overview" && <Overview go={go} />}
        {page === "compare" && <Compare />}
        {page === "board" && (
          <>
            <SectionTitle
              eyebrow="Reference Prototype 1 of 3"
              title="Vercel Board — working prototype"
              sub="Mock data, real mechanics: claim/renew/complete leases that expire, task dependencies that unblock, watchers that wake sleeping agents, scheduled follow-ups, per-channel grants with explain, schema-validated messages and two-way Slack/GitHub sync. Everything runs through the CLI at the bottom."
            />
            <BoardProto />
          </>
        )}
        {page === "buzz" && (
          <>
            <SectionTitle
              eyebrow="Reference Prototype 2 of 3"
              title="Buzz — working prototype"
              sub="Every item is a signed event in one hash-chained log. Post as humans or agents, watch the relay reject out-of-scope or revoked agents, open a branch room, fire YAML workflows, search everything and tamper with the audit log to see verification fail."
            />
            <BuzzProto />
          </>
        )}
        {page === "combined" && (
          <>
            <SectionTitle
              eyebrow="Reference Prototype 3 of 3 · before & after"
              title="Combined workflow — naive union vs hardened Hive"
              sub="Same scenario, same agents, same faults — two architectures. The ‘before’ is what you get by bolting Board's tasks onto Buzz's relay; the ‘after’ adds the authority kernel, fencing, verification, trust labels, an idempotent outbox, budgets and enforced gates."
            />
            <CombinedProto />
          </>
        )}
        {page === "diagrams" && <DiagramsPage />}
        {page === "guide" && <Guide />}
      </main>

      <footer className="border-t border-zinc-900 py-6 text-center text-xs text-zinc-600">
        Hive Authority Kernel (SQLite WAL + Ed25519 + FTS5) & design exploration · Vercel Board and Buzz are trademarks of their owners · not affiliated
      </footer>
    </div>
  );
}
