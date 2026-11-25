import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Bot,
  Clock,
  Hash,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Send,
  Terminal,
  User,
  FastForward,
  Link2,
  Shield,
  Eye,
  AlarmClock,
  GitBranch,
} from "lucide-react";
import { Badge, Btn, Card, Tabs } from "../components/ui";
import { Github, Slack } from "../components/brand";
import { cn } from "../utils/cn";
import { fmtClock, sleep } from "../lib/util";
import {
  ACTORS,
  CHANNELS,
  boardReducer,
  explain,
  initialBoard,
  isReady,
  runCommand,
  type CmdResult,
  type Thread,
} from "./boardEngine";

interface TermLine {
  kind: "in" | "out" | "err" | "note";
  who?: string;
  text: string;
}

const SLACK_BUGS = [
  "Search results page 500s when the query contains an apostrophe 😬",
  "Dark-mode toggle resets on refresh (Firefox)",
  "Invoice PDF is missing the VAT line for EU customers",
];

function taskLabel(s: ReturnType<typeof initialBoard>, t: Thread) {
  if (!t.task) return { text: "discussion", tone: "zinc" as const };
  if (t.task.state === "done") return { text: "done", tone: "emerald" as const };
  if (t.task.state === "claimed") return { text: `claimed · @${t.task.owner}`, tone: "amber" as const };
  return isReady(s, t) ? { text: "ready", tone: "sky" as const } : { text: "blocked", tone: "zinc" as const };
}

export default function BoardProto() {
  const [s, dispatch] = useReducer(boardReducer, undefined, initialBoard);
  const ref = useRef(s);
  ref.current = s;
  const [actor, setActor] = useState("you");
  const [sel, setSel] = useState("801");
  const [term, setTerm] = useState<TermLine[]>([
    { kind: "note", text: "Vercel Board CLI (mock). Everything in the UI runs these same commands. Type `help`." },
  ]);
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [running, setRunning] = useState(true);
  const [panel, setPanel] = useState<"agents" | "grants" | "watch" | "sync" | "events">("agents");
  const [reply, setReply] = useState("");
  const [slackIn, setSlackIn] = useState("");
  const busy = useRef(new Set<string>());
  const alive = useRef(true);
  const prNo = useRef(4412);
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => dispatch({ t: "tick", mins: 1 }), 1200);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => {
    termRef.current?.scrollTo({ top: 1e6 });
  }, [term]);

  const print = (...l: TermLine[]) => setTerm((t) => [...t, ...l].slice(-200));

  function exec(cmd: string, who: string = actor, echo = true): CmdResult {
    const r = runCommand(ref.current, who, cmd);
    if (echo) print({ kind: "in", who, text: cmd });
    r.actions.forEach((a) => dispatch(a));
    if (r.out.length) print(...r.out.map((o) => ({ kind: (o.startsWith("error") ? "err" : "out") as TermLine["kind"], text: o })));
    r.wake.forEach((w) => {
      print({ kind: "note", text: `⚡ ${w.reason} → waking @${w.agent} (no process was running)` });
      void runAgent(w.agent);
    });
    const th = r.actions.find((a) => a.t === "thread");
    if (th && th.t === "thread") setSel(th.thread.id);
    return r;
  }

  async function waitFor(cond: () => boolean, ms: number) {
    const t0 = Date.now();
    while (alive.current && !cond() && Date.now() - t0 < ms) await sleep(300);
  }

  async function runAgent(agent: string) {
    if (busy.current.has(agent)) return;
    busy.current.add(agent);
    try {
      await sleep(700);
      if (agent === "fixer") {
        const r = exec(`tasks claim --ready dev --label kind=bug --wait 10m`, agent);
        const c = r.actions.find((a) => a.t === "claim");
        if (!c || c.t !== "claim") return;
        const id = c.thread;
        const pr = prNo.current++;
        await sleep(1000);
        exec(`post ${id} "Reproduced it. Working on it — this might take ~30 minutes."`, agent);
        await sleep(1100);
        exec(`tasks renew ${id} --lease 1h`, agent);
        await sleep(1100);
        exec(`label ${id} pr=${pr}`, agent);
        exec(`post ${id} "Opened PR https://github.com/acme/www/pull/${pr}"`, agent);
        await sleep(900);
        exec(`schedule ${id} "Check CI for the pull request linked in this thread." --in 5m`, agent);
        print({ kind: "note", text: `@${agent} goes to sleep. Board will wake it in 5 simulated minutes.` });
        await waitFor(() => ref.current.scheds.some((x) => x.thread === id && x.fired), 120000);
        await sleep(700);
        exec(`tasks complete ${id} "Fix merged-ready. Can I get a review? https://github.com/acme/www/pull/${pr}"`, agent);
      } else if (agent === "reviewer") {
        const r = exec(`tasks claim --ready dev --label kind=review`, agent);
        const c = r.actions.find((a) => a.t === "claim");
        if (c && c.t === "claim") {
          await sleep(1200);
          exec(`post ${c.thread} "Reviewed the diff: correct, tests added. One nit on naming. Approving."`, agent);
          await sleep(900);
          exec(`tasks complete ${c.thread} "LGTM ✅ — approved."`, agent);
        } else {
          exec(`post 812 "Reviewed PR #4398: LGTM overall. Consider jitter on the backoff."`, agent);
        }
      } else if (agent === "sec-scan") {
        exec(
          `post security --schema security-finding@1 '{"repository":"acme/api","severity":"medium","status":"open","summary":"Missing rate limit on /api/login"}'`,
          agent,
        );
      }
    } finally {
      busy.current.delete(agent);
    }
  }

  function simulateSlack() {
    const st = ref.current;
    const id = String(st.nextThread);
    const text = SLACK_BUGS[(st.nextThread - 830) % SLACK_BUGS.length];
    dispatch({
      t: "thread",
      actor: "slack-sync",
      thread: {
        id,
        channel: "dev",
        title: text.length > 50 ? text.slice(0, 48) + "…" : text,
        labels: { kind: "bug", status: "ready" },
        origin: "slack",
        task: { state: "open", deps: [] },
        msgs: [{ id: "sl" + Date.now(), author: "dana (Slack)", kind: "slack", text, ts: st.now, sync: "slack" }],
      },
    });
    setSel(id);
    print({ kind: "note", text: `↘ Slack #bugs → Board: new thread #${id} in dev/ (synced by Vercel Connect)` });
    st.watchers.filter((w) => w.enabled && w.tail === "dev").forEach((w) => {
      print({ kind: "note", text: `⚡ watcher ${w.id} on dev/ → waking @${w.agent}` });
      void runAgent(w.agent);
    });
  }

  function simulateGithub() {
    const st = ref.current;
    dispatch({
      t: "msg",
      thread: "812",
      actor: "github-sync",
      msg: { author: "maria (GitHub)", kind: "github", text: "Review comment on retry.ts:42 — should we cap max attempts at 5?", sync: "github" },
    });
    setSel("812");
    print({ kind: "note", text: "↘ GitHub review comment → Board thread #812 (prs/)" });
    st.watchers.filter((w) => w.enabled && w.tail === "prs").forEach((w) => {
      print({ kind: "note", text: `⚡ watcher ${w.id} on prs/ → waking @${w.agent}` });
      void runAgent(w.agent);
    });
  }

  function slackReply() {
    if (!slackIn.trim()) return;
    const th = [...ref.current.threads].reverse().find((t) => t.origin === "slack");
    if (!th) return;
    dispatch({ t: "msg", thread: th.id, actor: "slack-sync", msg: { author: "dana (Slack)", kind: "slack", text: slackIn, sync: "slack" } });
    print({ kind: "note", text: `↘ Slack reply → Board #${th.id}` });
    ref.current.watchers.filter((w) => w.enabled && w.tail === th.channel).forEach((w) => void runAgent(w.agent));
    setSlackIn("");
  }

  const thread = s.threads.find((t) => t.id === sel) ?? s.threads[0];
  const readable = (ch: string) => explain(s.grants, actor, ch, "read").ok;
  const slackMsgs = useMemo(() => s.threads.flatMap((t) => t.msgs.filter((m) => m.sync === "slack").map((m) => ({ ...m, t: t.id }))).slice(-6), [s.threads]);
  const ghMsgs = useMemo(() => s.threads.flatMap((t) => t.msgs.filter((m) => m.sync === "github").map((m) => ({ ...m, t: t.id }))).slice(-5), [s.threads]);

  const canPost = thread ? explain(s.grants, actor, thread.channel, "post").ok : false;
  const myActor = ACTORS.find((a) => a.name === actor)!;

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-white text-black">
            <svg viewBox="0 0 24 24" className="h-4 w-4"><path d="M12 3 22 20H2z" fill="currentColor" /></svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-white">vercel board <span className="text-zinc-500">· prototype</span></div>
            <div className="text-[11px] text-zinc-500">headless message store · tasks · leases · watchers · grants</div>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            Act as
            <select
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white"
            >
              {ACTORS.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.kind === "agent" ? "🤖" : "👤"} {a.name} ({a.harness})
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
            <Clock size={13} /> sim {fmtClock(s.now)}
          </div>
          <Btn size="sm" onClick={() => setRunning((r) => !r)}>{running ? <Pause size={13} /> : <Play size={13} />}{running ? "Pause" : "Run"}</Btn>
          <Btn size="sm" onClick={() => dispatch({ t: "tick", mins: 10 })}><FastForward size={13} /> +10m</Btn>
          <Btn size="sm" variant="ghost" onClick={() => { dispatch({ t: "reset" }); setTerm([{ kind: "note", text: "State reset." }]); }}><RotateCcw size={13} /> Reset</Btn>
        </div>
      </div>

      {/* scenario strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Try a flow:</span>
        <Btn size="sm" onClick={simulateSlack}><Slack size={13} /> 1 · Slack bug arrives</Btn>
        <Btn size="sm" onClick={() => void runAgent("fixer")}><Bot size={13} /> 2 · Wake fixer</Btn>
        <Btn size="sm" onClick={() => void runAgent("reviewer")}><Bot size={13} /> 3 · Wake reviewer (needs #801 done)</Btn>
        <Btn size="sm" onClick={simulateGithub}><Github size={13} /> GitHub review comment</Btn>
        <Btn size="sm" onClick={() => void runAgent("sec-scan")}><Shield size={13} /> sec-scan posts finding</Btn>
        <Btn size="sm" onClick={() => exec(`post security "hello from fixer"`, "fixer")}><Lock size={13} /> fixer → security/ (denied)</Btn>
      </div>

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)_350px]">
        {/* channels */}
        <Card className="max-h-[560px] overflow-y-auto p-2">
          {CHANNELS.map((ch) => {
            const ok = readable(ch);
            const list = s.threads.filter((t) => t.channel === ch);
            return (
              <div key={ch} className="mb-2">
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  <Hash size={12} /> {ch}
                  {!ok && <Lock size={11} className="text-rose-400" />}
                </div>
                {!ok ? (
                  <div className="px-2 py-1 text-[11px] text-zinc-600">No read grant for {actor}</div>
                ) : (
                  list.map((t) => {
                    const l = taskLabel(s, t);
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSel(t.id)}
                        className={cn(
                          "mb-0.5 w-full rounded-lg px-2 py-1.5 text-left transition",
                          sel === t.id ? "bg-white/10" : "hover:bg-zinc-800/70",
                        )}
                      >
                        <div className="truncate text-[12px] text-zinc-200">
                          <span className="text-zinc-500">#{t.id}</span> {t.title}
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          <Badge tone={l.tone}>{l.text}</Badge>
                          {t.origin !== "board" && <Badge tone="violet">{t.origin}</Badge>}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            );
          })}
        </Card>

        {/* thread */}
        <Card className="flex max-h-[560px] min-h-[420px] flex-col">
          {thread && readable(thread.channel) ? (
            <>
              <div className="border-b border-zinc-800 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="white">#{thread.id}</Badge>
                  <Badge><Hash size={10} />{thread.channel}</Badge>
                  <Badge tone={taskLabel(s, thread).tone}>{taskLabel(s, thread).text}</Badge>
                  {thread.task?.state === "claimed" && thread.task.leaseUntil !== undefined && (
                    <Badge tone={thread.task.leaseUntil - s.now < 8 ? "rose" : "amber"}>
                      <AlarmClock size={10} /> lease {Math.max(0, thread.task.leaseUntil - s.now)}m left
                    </Badge>
                  )}
                  {thread.task && thread.task.deps.length > 0 && (
                    <Badge tone="violet"><Link2 size={10} /> needs {thread.task.deps.map((d) => "#" + d).join(", ")}</Badge>
                  )}
                </div>
                <h3 className="mt-2 text-base font-semibold text-white">{thread.title}</h3>
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(thread.labels).map(([k, v]) => (
                    <span key={k} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{k}={v}</span>
                  ))}
                </div>
                {thread.task && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Btn size="sm" disabled={!isReady(s, thread)} onClick={() => exec(`tasks claim --ready ${thread.channel} --label kind=${thread.labels.kind}`)}>Claim as {actor}</Btn>
                    <Btn size="sm" disabled={thread.task.state !== "claimed"} onClick={() => exec(`tasks renew ${thread.id} --lease 1h`)}>Renew 1h</Btn>
                    <Btn size="sm" disabled={thread.task.state !== "claimed"} onClick={() => exec(`tasks complete ${thread.id} "Done — see thread."`)}>Complete</Btn>
                    <Btn size="sm" variant="ghost" onClick={() => exec(`schedule ${thread.id} "Re-check this task." --in 5m --no-sync`)}><AlarmClock size={13} /> Schedule (--no-sync)</Btn>
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {thread.msgs.map((m) => (
                  <div key={m.id} className={cn("flex gap-2.5", m.kind === "system" && "opacity-80")}>
                    <div className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px]", m.kind === "agent" ? "bg-sky-500/20 text-sky-300" : m.kind === "slack" ? "bg-fuchsia-500/20 text-fuchsia-300" : m.kind === "github" ? "bg-zinc-100 text-black" : m.kind === "system" ? "bg-zinc-800 text-zinc-400" : "bg-emerald-500/20 text-emerald-300")}>
                      {m.kind === "agent" ? <Bot size={14} /> : m.kind === "slack" ? <Slack size={13} /> : m.kind === "github" ? <Github size={13} /> : m.kind === "system" ? <Eye size={13} /> : <User size={13} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-zinc-200">{m.author}</span>
                        <span className="text-zinc-600">{fmtClock(m.ts)}</span>
                        {m.sync === "slack" && <Badge tone="violet"><Slack size={9} />synced</Badge>}
                        {m.sync === "github" && <Badge tone="zinc"><Github size={9} />synced</Badge>}
                        {m.sync === "internal" && <Badge tone="amber">board-only note</Badge>}
                      </div>
                      <div className={cn("mt-0.5 text-sm leading-relaxed", m.kind === "system" ? "italic text-zinc-500" : "text-zinc-300")}>{m.text}</div>
                      {m.data && (
                        <div className="mt-1.5 rounded-lg border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] text-emerald-300">
                          <div className="mb-1 text-zinc-500">schema · {m.schema} ✓ validated</div>
                          {Object.entries(m.data).map(([k, v]) => (
                            <div key={k}>{k}: <span className="text-white">{String(v)}</span></div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="flex gap-2 border-t border-zinc-800 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!reply.trim()) return;
                  exec(`post ${thread.id} "${reply.replace(/"/g, "'")}"`);
                  setReply("");
                }}
              >
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={canPost ? `Reply as ${actor} → \`vercel board post ${thread.id}\`` : `${actor} has no post grant on ${thread.channel}/`}
                  disabled={!canPost}
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-white/40 focus:outline-none disabled:opacity-50"
                />
                <Btn variant="primary" disabled={!canPost}><Send size={14} /></Btn>
              </form>
            </>
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center text-sm text-zinc-500">
              <div>
                <Lock className="mx-auto mb-2 text-rose-400" />
                {actor} has no read grant on this channel.
                <div className="mt-1 text-xs">Switch “Act as” to <b>you</b> or <b>sec-scan</b>, or create a grant in the Grants tab.</div>
              </div>
            </div>
          )}
        </Card>

        {/* side panel */}
        <Card className="flex max-h-[560px] flex-col">
          <div className="border-b border-zinc-800 p-2">
            <Tabs
              size="sm"
              value={panel}
              onChange={setPanel}
              tabs={[
                { id: "agents", label: "Agents" },
                { id: "grants", label: "Grants" },
                { id: "watch", label: "Watch" },
                { id: "sync", label: "Sync" },
                { id: "events", label: "Events" },
              ]}
            />
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3 text-xs">
            {panel === "agents" &&
              ACTORS.filter((a) => a.kind === "agent").map((a) => {
                const owned = s.threads.filter((t) => t.task?.owner === a.name);
                return (
                  <div key={a.name} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="flex items-center gap-2">
                      <Bot size={14} className="text-sky-300" />
                      <span className="font-semibold text-white">@{a.name}</span>
                      <Badge>{a.harness}</Badge>
                      <Badge tone={busy.current.has(a.name) || owned.length ? "amber" : "zinc"}>{owned.length ? "working" : "asleep"}</Badge>
                    </div>
                    <div className="mt-2 text-zinc-500">
                      {owned.length ? owned.map((t) => `#${t.id} (${Math.max(0, (t.task?.leaseUntil ?? 0) - s.now)}m lease)`).join(", ") : "No process running. Wakes via watcher or schedule."}
                    </div>
                    <Btn size="sm" className="mt-2" onClick={() => void runAgent(a.name)}>Wake now</Btn>
                  </div>
                );
              })}
            {panel === "grants" && (
              <>
                {s.grants.map((g) => (
                  <div key={g.id} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 font-mono">
                    <span className="text-zinc-500">{g.id}</span>
                    <span className="text-white">{g.principal}</span>
                    <span className="text-zinc-400">{g.path || "/"}</span>
                    <Badge tone={g.can.includes("none") ? "rose" : g.can.includes("all") ? "emerald" : "sky"}>{g.can.join(",")}</Badge>
                    <button className="ml-auto text-zinc-500 hover:text-rose-400" onClick={() => exec(`grants revoke ${g.id}`, "you")}>revoke</button>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Btn size="sm" onClick={() => exec(`grants create --user fixer --can 'security/=read,post'`, "you")}>Grant fixer security/</Btn>
                  <Btn size="sm" onClick={() => exec(`grants explain --user fixer security`, "you")}>Explain fixer</Btn>
                </div>
              </>
            )}
            {panel === "watch" && (
              <>
                <div className="text-zinc-500">Watchers wake agents when a new event lands in a channel — no resident process.</div>
                {s.watchers.map((w) => (
                  <div key={w.id} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
                    <span className="font-mono text-zinc-500">{w.id}</span>
                    <span className="text-zinc-300">tail <b className="text-white">{w.tail}/</b> → @{w.agent}</span>
                    <button onClick={() => dispatch({ t: "watcher", id: w.id })} className={cn("ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold", w.enabled ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-800 text-zinc-500")}>
                      {w.enabled ? "ON" : "OFF"}
                    </button>
                  </div>
                ))}
                <div className="pt-2 font-semibold text-zinc-300">Scheduled follow-ups</div>
                {s.scheds.length === 0 && <div className="text-zinc-600">None yet. Run the fixer flow or press “Schedule”.</div>}
                {s.scheds.map((sc) => (
                  <div key={sc.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
                    <div className="flex items-center gap-2">
                      <AlarmClock size={12} className="text-amber-300" />
                      <span className="text-zinc-300">#{sc.thread} @{sc.agent}</span>
                      <Badge tone={sc.fired ? "emerald" : "amber"}>{sc.fired ? "fired" : `in ${Math.max(0, sc.at - s.now)}m`}</Badge>
                      {sc.noSync && <Badge>no-sync</Badge>}
                    </div>
                    <div className="mt-1 text-zinc-500">{sc.prompt}</div>
                  </div>
                ))}
              </>
            )}
            {panel === "sync" && (
              <>
                <div className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/5 p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-fuchsia-300"><Slack size={13} /> Slack · #bugs (mirror)</div>
                  <div className="max-h-28 space-y-1 overflow-y-auto">
                    {slackMsgs.length === 0 && <div className="text-zinc-600">nothing yet</div>}
                    {slackMsgs.map((m) => (
                      <div key={m.id} className="text-zinc-300"><b className="text-zinc-100">{m.author.replace(" (Slack)", "")}</b> <span className="text-zinc-600">#{m.t}</span> {m.text.slice(0, 90)}</div>
                    ))}
                  </div>
                  <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); slackReply(); }}>
                    <input value={slackIn} onChange={(e) => setSlackIn(e.target.value)} placeholder="Reply in Slack → lands in Board" className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-white placeholder:text-zinc-600" />
                    <Btn size="sm">Send</Btn>
                  </form>
                </div>
                <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-zinc-200"><GitBranch size={13} /> GitHub · acme/www (mirror)</div>
                  <div className="space-y-1">
                    {ghMsgs.length === 0 && <div className="text-zinc-600">nothing yet</div>}
                    {ghMsgs.map((m) => (
                      <div key={m.id} className="text-zinc-300"><b className="text-zinc-100">{m.author.replace(" (GitHub)", "")}</b> <span className="text-zinc-600">#{m.t}</span> {m.text.slice(0, 90)}</div>
                    ))}
                  </div>
                </div>
                <div className="text-zinc-500">Replies, reactions, edits and deletes mirror both ways. Agent notes posted with <code>--no-sync</code> stay on the Board.</div>
              </>
            )}
            {panel === "events" && (
              <div className="space-y-1 font-mono text-[11px]">
                {s.events.length === 0 && <div className="text-zinc-600">No activity yet.</div>}
                {s.events.slice(0, 40).map((e) => (
                  <div key={e.id} className="flex gap-2 text-zinc-400">
                    <span className="text-zinc-600">{fmtClock(e.ts)}</span>
                    <span className="text-sky-300">{e.actor}</span>
                    <span className="text-zinc-200">{e.op}</span>
                    <span className="truncate text-zinc-500">{e.target}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* terminal */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-black/40 px-3 py-2 text-xs text-zinc-400">
          <Terminal size={13} /> vercel board CLI <span className="text-zinc-600">· acting as</span> <b className="text-white">{myActor.name}</b>
          <button className="ml-auto text-zinc-500 hover:text-white" onClick={() => setTerm([])}>clear</button>
        </div>
        <div ref={termRef} className="h-56 overflow-y-auto bg-black/60 p-3 font-mono text-[12px] leading-relaxed">
          {term.map((l, i) => (
            <div key={i} className={cn("whitespace-pre-wrap", l.kind === "err" && "text-rose-400", l.kind === "out" && "text-zinc-300", l.kind === "note" && "text-amber-300/80", l.kind === "in" && "text-white")}>
              {l.kind === "in" && (<span className="text-emerald-400">{l.who}@board $ vercel board </span>)}
              {l.text}
            </div>
          ))}
        </div>
        <form
          className="flex items-center gap-2 border-t border-zinc-800 bg-black/60 px-3 py-2 font-mono text-[12px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            exec(input.replace(/^(vercel )?(board )?/, ""));
            setHist((h) => [input, ...h]);
            setHi(-1);
            setInput("");
          }}
        >
          <span className="text-emerald-400">{actor}@board $ vercel board</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.min(hist.length - 1, hi + 1);
                setHi(n);
                if (hist[n]) setInput(hist[n]);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = Math.max(-1, hi - 1);
                setHi(n);
                setInput(n === -1 ? "" : hist[n]);
              }
            }}
            spellCheck={false}
            placeholder="threads · tasks claim --ready dev · grants explain --user fixer security · help"
            className="flex-1 bg-transparent text-white placeholder:text-zinc-700 focus:outline-none"
          />
        </form>
      </Card>
    </div>
  );
}
