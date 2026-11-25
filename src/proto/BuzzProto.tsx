import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Bot,
  Check,
  FastForward,
  GitMerge,
  Hash,
  KeyRound,
  Pause,
  Play,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  User,
  X,
  Workflow,
  Fingerprint,
  Link as LinkIcon,
  GitPullRequest,
} from "lucide-react";
import { Badge, Btn, Card, Code, Tabs } from "../components/ui";
import { cn } from "../utils/cn";
import { fmtClock, hex, sleep } from "../lib/util";
import {
  BRANCH_CH,
  K,
  KIND_NAME,
  agentReply,
  buzzReducer,
  channelsOf,
  search,
  seed,
  verifyChain,
  wireId,
  type BAction,
  type BEvent,
  type Draft,
  type VerifyResult,
} from "./buzzEngine";

type Tab = "chat" | "branch" | "flows" | "identity" | "audit";

const WF_YAML: Record<string, string> = {
  "release-notes": `name: release-notes
trigger:
  webhook: git.tag        # also: message | reaction | schedule
steps:
  - agent: goose-triage
    do: draft_notes_from_merged_prs
  - post: "#releases"
  - wait_for: reaction("👍")   # human sign-off
  - do: publish_release`,
  "triage-on-message": `name: triage-on-message
trigger:
  message:
    channel: "#general"
    matches: "bug|error|broken"
steps:
  - agent: goose-triage
    do: classify_and_suggest_owner
  - reply: in_thread`,
  "standup-digest": `name: standup-digest
trigger:
  schedule: "every 30m"     # sim-time
steps:
  - agent: goose-triage
    do: summarize_open_threads
  - post: "#general"`,
};

export default function BuzzProto() {
  const [s, dispatch] = useReducer(buzzReducer, undefined, seed);
  // ref is kept authoritative synchronously: every state-mutating action goes
  // through dispatchSync, which applies the reducer once to keep ref.current
  // fresh, then forwards the same action to React. Rapid back-to-back calls
  // (send/runStandup/afterHuman) therefore always read the latest state.
  const ref = useRef(s);
  function dispatchSync(a: BAction) {
    ref.current = buzzReducer(ref.current, a);
    dispatch(a);
  }
  const [tab, setTab] = useState<Tab>("chat");
  const [ch, setCh] = useState("general");
  const [me, setMe] = useState("ana");
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<BEvent | null>(null);
  const [inspect, setInspect] = useState<BEvent | null>(null);
  const [running, setRunning] = useState(true);
  const [q, setQ] = useState("");
  const [ver, setVer] = useState<VerifyResult | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => dispatchSync({ t: "tick", m: 1 }), 2000);
    return () => clearInterval(id);
  }, [running]);

  // standup digest workflow (schedule trigger)
  useEffect(() => {
    if (s.wfEnabled["standup-digest"] && s.now > 0 && s.now % 30 === 0) runStandup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.now]);

  function runStandup() {
    const st = ref.current;
    const open = st.log.filter((e) => e.kind === K.chat && e.ch !== "general").length;
    send({ actor: "goose-triage", kind: K.run, ch: "general", content: `standup-digest · ${st.log.length} events in log, ${open} messages in project channels, ${st.rejected.length} relay rejections.`, tags: [["wf", "standup-digest"]] });
  }

  /** publish through the relay and report accept/reject */
  function send(d: Draft, quiet = false) {
    const before = ref.current.rejected.length;
    dispatchSync({ t: "publish", d });
    const after = ref.current;
    const rejected = after.rejected.length > before;
    if (!quiet || rejected)
      setToast(rejected ? { ok: false, msg: `relay: OK false — ${after.rejected[0].reason}` } : { ok: true, msg: `relay: OK true — ${KIND_NAME[d.kind] ?? d.kind} by ${d.actor} signed & appended` });
    return !rejected;
  }
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(id);
  }, [toast]);

  async function afterHuman(content: string, channel: string, evId: string) {
    const lc = content.toLowerCase();
    const r = agentReply(content, ref.current);
    if (!r) return;
    const mention = /@(goose|triage|claude|codex|fixer|review)/.test(lc) || /have we seen|seen this/.test(lc);
    if (r.actor === "goose-triage" && !mention && !ref.current.wfEnabled["triage-on-message"]) return;
    await sleep(900);
    dispatchSync({ t: "publish", d: { actor: r.actor, kind: K.chat, ch: channel, content: r.content, tags: [["e", evId, "reply"], ...(r.tags ?? [])] } });
  }

  function post() {
    if (!text.trim()) return;
    const c = text.trim();
    const st = ref.current;
    const tags = replyTo ? [["e", replyTo.id, "reply"]] : [];
    const id = wireId({ prev: st.log[st.log.length - 1].id, kind: K.chat, actor: me, ch, content: c, ts: st.now, tags });
    const ok = send({ actor: me, kind: K.chat, ch, content: c, tags });
    setText("");
    setReplyTo(null);
    if (ok && st.ids.find((i) => i.name === me)?.type === "human") void afterHuman(c, ch, id);
  }

  const channels = channelsOf(s);
  const branchEvents = s.log.filter((e) => e.ch === BRANCH_CH);
  const has = (k: number) => branchEvents.some((e) => e.kind === k);
  const merged = has(K.applied);
  const approved = has(K.approve);
  const patchEv = branchEvents.find((e) => e.kind === K.patch);

  const hits = useMemo(() => (q.trim().length > 1 ? search(s, q) : []), [q, s]);
  const humans = s.ids.filter((i) => i.type === "human");
  const agents = s.ids.filter((i) => i.type === "agent");
  const pendingRun = s.pending[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-400 text-lg text-black">🐝</div>
          <div>
            <div className="text-sm font-semibold text-white">Buzz <span className="text-zinc-500">· prototype</span></div>
            <div className="text-[11px] text-zinc-500">one relay · one signed event log · humans + agents + workflows + git</div>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge tone="amber">relay ws://localhost:3000 (mock)</Badge>
          <Badge>{s.log.length} signed events</Badge>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">sim {fmtClock(s.now)}</div>
          <Btn size="sm" onClick={() => setRunning((r) => !r)}>{running ? <Pause size={13} /> : <Play size={13} />}</Btn>
          <Btn size="sm" onClick={() => dispatchSync({ t: "tick", m: 10 })}><FastForward size={13} /> +10m</Btn>
          <Btn size="sm" variant="ghost" onClick={() => { dispatchSync({ t: "reset" }); setVer(null); setToast(null); }}><RotateCcw size={13} /> Reset</Btn>
        </div>
      </div>

      <Tabs
        accent="amber"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "chat", label: "Channels & threads" },
          { id: "branch", label: "Branch as room" },
          { id: "flows", label: "Workflows" },
          { id: "identity", label: "Identity & attestations" },
          { id: "audit", label: "Search & audit" },
        ]}
      />

      {toast && (
        <div className={cn("fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 font-mono text-xs shadow-xl", toast.ok ? "border-emerald-500/40 bg-emerald-950 text-emerald-200" : "border-rose-500/40 bg-rose-950 text-rose-200")}>
          {toast.msg}
        </div>
      )}

      {tab === "chat" && (
        <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
          <Card className="p-2">
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Channels</div>
            {channels.map((c) => (
              <button key={c} onClick={() => setCh(c)} className={cn("flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm", ch === c ? "bg-amber-400/15 text-amber-200" : "text-zinc-400 hover:bg-zinc-800")}>
                <Hash size={13} /> <span className="truncate">{c}</span>
                <span className="ml-auto text-[10px] text-zinc-600">{s.log.filter((e) => e.ch === c).length}</span>
              </button>
            ))}
          </Card>
          <Card className="flex max-h-[600px] min-h-[420px] flex-col">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-white">
              <Hash size={14} /> {ch}
              <span className="text-xs font-normal text-zinc-500">every item below is a signed event — click ⛓ to inspect</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <Feed s={s} ch={ch} onInspect={setInspect} onReply={setReplyTo} onReact={(e) => send({ actor: me, kind: K.react, ch: e.ch, content: "👍", tags: [["e", e.id]] })} />
            </div>
            {replyTo && (
              <div className="mx-3 flex items-center gap-2 rounded-t-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
                Replying to {replyTo.actor}: {replyTo.content.slice(0, 50)}
                <button className="ml-auto" onClick={() => setReplyTo(null)}><X size={12} /></button>
              </div>
            )}
            <form className="flex gap-2 border-t border-zinc-800 p-3" onSubmit={(e) => { e.preventDefault(); post(); }}>
              <select value={me} onChange={(e) => setMe(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs text-white">
                {s.ids.map((i) => <option key={i.name} value={i.name}>{i.type === "agent" ? "🤖" : "👤"} {i.name}</option>)}
              </select>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder='Try: "have we seen this error before? Safari form submit 500" or "bug: dark mode resets"' className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-amber-400/50 focus:outline-none" />
              <Btn variant="amber"><Send size={14} /></Btn>
            </form>
          </Card>
        </div>
      )}

      {tab === "branch" && (
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-white"><GitPullRequest size={15} className="text-amber-300" /> Branch → room → merge</div>
            <p className="text-xs text-zinc-500">Open a branch and a channel appears. Patches (NIP-34), CI, review, approval and the merge decision all land as events in that room.</p>
            {[
              { n: 1, label: "Ben opens branch fix/safari-pay", done: channels.includes(BRANCH_CH), go: () => { send({ actor: "ben", kind: K.chanNew, ch: "proj-checkout", content: BRANCH_CH }, true); setTimeout(() => dispatchSync({ t: "publish", d: { actor: "ben", kind: K.open, ch: BRANCH_CH, content: "branch fix/safari-pay opened against main", tags: [["r", "acme/www"]] } }), 50); }, dis: channels.includes(BRANCH_CH) },
              { n: 2, label: "codex-fixer pushes a patch", done: has(K.patch), go: () => send({ actor: "codex-fixer", kind: K.patch, ch: BRANCH_CH, content: "diff --git a/src/checkout.ts\n- form.submit()\n+ form.requestSubmit()   // Safari 17 fix\n+ import './polyfills/requestSubmit'", tags: [["r", "acme/www"], ["commit", hex("patch1", 12)]] }), dis: !channels.includes(BRANCH_CH) },
              { n: 3, label: "ci-bot posts CI result", done: has(K.ci), go: () => send({ actor: "ci-bot", kind: K.ci, ch: BRANCH_CH, content: "✅ 14/14 checks passed", tags: [["e", patchEv?.id ?? ""]] }), dis: !has(K.patch) },
              { n: 4, label: "claude-reviewer posts first-pass review", done: has(K.review), go: () => send({ actor: "claude-reviewer", kind: K.review, ch: BRANCH_CH, content: "LGTM. One nit: add a regression test for Safari 16 fallback.", tags: [["e", patchEv?.id ?? ""]] }), dis: !has(K.patch) },
              { n: 5, label: "Ana approves (human)", done: approved, go: () => send({ actor: "ana", kind: K.approve, ch: BRANCH_CH, content: "Approved head " + hex("patch1", 12), tags: [["e", patchEv?.id ?? ""]] }), dis: !has(K.patch) },
              { n: 6, label: "Ben merges", done: merged, go: () => send({ actor: "ben", kind: K.applied, ch: BRANCH_CH, content: "merged into main", tags: [["r", "acme/www"]] }), dis: !has(K.patch) },
            ].map((st) => (
              <div key={st.n} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
                <div className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold", st.done ? "bg-emerald-500 text-black" : "bg-zinc-800 text-zinc-400")}>{st.done ? <Check size={13} /> : st.n}</div>
                <div className="flex-1 text-xs text-zinc-300">{st.label}</div>
                <Btn size="sm" disabled={st.dis || st.done} onClick={st.go}>Run</Btn>
              </div>
            ))}
            <div className="grid grid-cols-1 gap-2 pt-1">
              <Btn size="sm" variant="ghost" className="justify-start text-rose-300" onClick={() => send({ actor: "claude-reviewer", kind: K.approve, ch: BRANCH_CH, content: "I approve my own review" })}>
                <ShieldAlert size={13} /> Agent tries to cast an approval (relay should reject)
              </Btn>
            </div>
            {merged && !approved && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                <b>⚠ Merged with no human approval on record.</b> Buzz logged it faithfully — but nothing stopped it. Buzz's docs mark workflow approval gates as “infra exists, glue still drying”. This is exactly the gap the combined v2 closes with an enforced, SHA-bound gate.
              </div>
            )}
            {merged && approved && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">Merged with approval, review and CI all in one room — searchable forever.</div>}
          </Card>
          <Card className="flex max-h-[640px] flex-col">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-white"><Hash size={14} /> {BRANCH_CH}</div>
            <div className="flex-1 overflow-y-auto p-4">
              {channels.includes(BRANCH_CH) ? <Feed s={s} ch={BRANCH_CH} onInspect={setInspect} onReply={setReplyTo} onReact={() => undefined} /> : <div className="grid h-40 place-items-center text-sm text-zinc-600">Open the branch to create this room.</div>}
            </div>
          </Card>
        </div>
      )}

      {tab === "flows" && (
        <div className="grid gap-4 lg:grid-cols-3">
          {[
            { id: "release-notes", title: "Release that writes itself", sub: "webhook → draft → 👍 → ship" },
            { id: "triage-on-message", title: "Triage on message", sub: "message trigger" },
            { id: "standup-digest", title: "Standup digest", sub: "schedule trigger" },
          ].map((w) => (
            <Card key={w.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start gap-2">
                <Workflow size={16} className="mt-0.5 text-amber-300" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-white">{w.title}</div>
                  <div className="text-xs text-zinc-500">{w.sub}</div>
                </div>
                <button onClick={() => dispatchSync({ t: "toggleWf", id: w.id })} className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", s.wfEnabled[w.id] ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-800 text-zinc-500")}>{s.wfEnabled[w.id] ? "ENABLED" : "DISABLED"}</button>
              </div>
              <Code>{WF_YAML[w.id]}</Code>
              {w.id === "release-notes" && (
                <div className="flex flex-wrap gap-2">
                  <Btn size="sm" variant="amber" disabled={!s.wfEnabled[w.id]} onClick={() => { setCh("releases"); dispatchSync({ t: "wfRelease", phase: 1 }); setTimeout(() => dispatchSync({ t: "wfRelease", phase: 2 }), 1200); }}>Fire webhook (tag v0.4.22)</Btn>
                  <Btn size="sm" disabled={!pendingRun} onClick={() => send({ actor: "ana", kind: K.react, ch: "releases", content: "👍", tags: [["e", pendingRun.msgId]] })}>React 👍 as ana</Btn>
                </div>
              )}
              {w.id === "triage-on-message" && <Btn size="sm" variant="amber" onClick={() => { setCh("general"); const t = "bug: dark mode toggle resets after refresh"; const st = ref.current; const id = wireId({ prev: st.log[st.log.length - 1].id, kind: K.chat, actor: "ben", ch: "general", content: t, ts: st.now, tags: [] }); send({ actor: "ben", kind: K.chat, ch: "general", content: t }); void afterHuman(t, "general", id); setTab("chat"); }}>Post “bug: dark mode…” in #general</Btn>}
              {w.id === "standup-digest" && <Btn size="sm" variant="amber" onClick={runStandup}>Run now</Btn>}
              <div className="border-t border-zinc-800 pt-2">
                <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">Recent runs (events)</div>
                <div className="space-y-1">
                  {s.log.filter((e) => e.kind === K.run && e.tags.some((t) => t[0] === "wf" && t[1] === w.id)).slice(-3).map((e) => (
                    <div key={e.seq} className="text-[11px] text-zinc-400">#{e.seq} · {e.content}</div>
                  ))}
                  {!s.log.some((e) => e.kind === K.run && e.tags.some((t) => t[1] === w.id)) && <div className="text-[11px] text-zinc-600">no runs yet</div>}
                </div>
              </div>
            </Card>
          ))}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-zinc-400 lg:col-span-3">
            <b className="text-amber-300">Note:</b> workflow runs, drafts and reactions are the <i>same</i> kind of event as chat — so “search the conversation, the patch, the workflow run and the approval in one place” just works. Approval-gate steps are not wired end-to-end in Buzz yet (see Branch tab).
          </div>
        </div>
      )}

      {tab === "identity" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <Card className="overflow-x-auto p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><KeyRound size={15} className="text-amber-300" /> Participants — same identity shape for people and agents</div>
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="text-zinc-500">
                <tr><th className="pb-2">Identity</th><th>Public key</th><th>Owner attestation</th><th className="text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {[...humans, ...agents].map((i) => {
                  const a = i.attest;
                  const valid = a && !a.revoked && a.expires > s.now;
                  return (
                    <tr key={i.name} className="align-top">
                      <td className="py-2.5">
                        <div className="flex items-center gap-1.5 font-semibold text-zinc-100">{i.type === "agent" ? <Bot size={13} className="text-sky-300" /> : <User size={13} className="text-emerald-300" />}{i.name}</div>
                        {i.harness && <div className="text-zinc-500">{i.harness}</div>}
                      </td>
                      <td className="font-mono text-zinc-400">{i.pub.slice(0, 18)}…</td>
                      <td>
                        {i.type === "human" ? <span className="text-zinc-600">— (root of authority)</span> : (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              <Badge tone={valid ? "emerald" : "rose"}>{a?.revoked ? "revoked" : valid ? "valid" : "expired"}</Badge>
                              <span className="text-zinc-500">signed by {i.owner}</span>
                            </div>
                            <div className="text-zinc-500">scope: {a?.scope.map((k) => KIND_NAME[k]).join(", ")}</div>
                            <div className="text-zinc-600">{a && a.expires > s.now ? `expires in ${a.expires - s.now}m` : ""}</div>
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        {i.type === "agent" && (
                          <div className="flex flex-wrap justify-end gap-1">
                            <Btn size="sm" onClick={() => dispatchSync({ t: "attest", agent: i.name, op: a?.revoked ? "restore" : "revoke" })}>{a?.revoked ? "Restore" : "Revoke"}</Btn>
                            <Btn size="sm" variant="ghost" onClick={() => dispatchSync({ t: "attest", agent: i.name, op: "expire" })}>Expire</Btn>
                            <Btn size="sm" variant="amber" onClick={() => { setCh("general"); send({ actor: i.name, kind: i.attest?.scope.includes(K.chat) ? K.chat : K.ci, ch: "general", content: `Hello from ${i.name} (${i.harness})` }); }}>Post as agent</Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-3 text-[11px] text-zinc-500">Authorship (who signed) and authority (who allowed it) are verified independently. Owner key ≠ agent key, so nothing can attest for itself.</div>
          </Card>
          <div className="space-y-4">
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><Fingerprint size={15} className="text-amber-300" /> Attestation tag (illustrative)</div>
              <Code>{JSON.stringify({ kind: K.chat, pubkey: agents[0].pub.slice(0, 20) + "…", tags: [["attest", agents[0].owner, `scope=${agents[0].attest?.scope.join(",")}`, `exp=${agents[0].attest?.expires}`, "sig=" + hex(agents[0].name + "att", 24)]] }, null, 2)}</Code>
            </Card>
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><ShieldAlert size={15} className="text-rose-300" /> Relay rejections</div>
              <div className="space-y-1.5 font-mono text-[11px]">
                {s.rejected.length === 0 && <div className="text-zinc-600">None yet — revoke an agent, then press “Post as agent”.</div>}
                {s.rejected.map((r, i) => (
                  <div key={i} className="rounded border border-rose-500/20 bg-rose-500/5 p-1.5 text-rose-200">{fmtClock(r.ts)} · {r.actor} · kind {r.kind}<div className="text-rose-300/80">{r.reason}</div></div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === "audit" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><Search size={15} className="text-amber-300" /> One search across chat, patches, CI, approvals, runs</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="try: safari, polyfill, approval, release…" className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none" />
            <div className="mt-3 max-h-96 space-y-2 overflow-y-auto">
              {q.trim().length > 1 && hits.length === 0 && <div className="text-xs text-zinc-600">No results.</div>}
              {hits.slice(0, 20).map((e) => (
                <button key={e.seq} onClick={() => setInspect(e)} className="block w-full rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 text-left hover:border-amber-400/40">
                  <div className="flex items-center gap-2 text-[11px]"><Badge tone="amber">{KIND_NAME[e.kind]}</Badge><span className="text-zinc-400">#{e.seq} · {e.ch} · {e.actor}</span></div>
                  <div className="mt-1 line-clamp-2 text-xs text-zinc-300">{e.content}</div>
                </button>
              ))}
            </div>
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck size={15} className="text-amber-300" /> Hash-chained audit log</div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Btn size="sm" variant="amber" onClick={() => setVer(verifyChain(ref.current))}>Verify chain</Btn>
              <Btn size="sm" variant="danger" disabled={!!s.tamper} onClick={() => { dispatchSync({ t: "tamper", seq: 3 }); setVer(null); }}>Tamper with event #3</Btn>
              <Btn size="sm" disabled={!s.tamper} onClick={() => { dispatchSync({ t: "untamper" }); setVer(null); }}>Undo tamper</Btn>
            </div>
            {ver && (
              <div className={cn("mb-3 rounded-lg border p-2.5 text-xs", ver.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-rose-500/40 bg-rose-500/10 text-rose-200")}>
                {ver.ok ? `✓ ${s.log.length} events verified: links, ids and signatures all consistent.` : `✗ Chain broken at event #${ver.bad}: ${ver.reason}`}
              </div>
            )}
            <div className="max-h-80 overflow-y-auto font-mono text-[11px]">
              {s.log.slice().reverse().slice(0, 40).map((e) => (
                <button key={e.seq} onClick={() => setInspect(e)} className={cn("flex w-full gap-2 border-b border-zinc-800/60 py-1 text-left hover:bg-zinc-800/40", ver && !ver.ok && ver.bad === e.seq && "bg-rose-500/15")}>
                  <span className="w-7 text-zinc-600">#{e.seq}</span>
                  <span className="w-24 truncate text-sky-300">{e.actor}</span>
                  <span className="w-24 truncate text-amber-300">{KIND_NAME[e.kind]}</span>
                  <span className="text-zinc-500">{e.id.slice(0, 10)}←{e.prev.slice(0, 6)}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {inspect && <Inspector ev={inspect} s={s} onClose={() => setInspect(null)} />}
    </div>
  );
}

function Feed({ s, ch, onInspect, onReply, onReact }: { s: ReturnType<typeof seed>; ch: string; onInspect: (e: BEvent) => void; onReply: (e: BEvent) => void; onReact: (e: BEvent) => void }) {
  const evs = s.log.filter((e) => e.ch === ch && e.kind !== K.react && e.kind !== K.chanNew);
  const isReply = (e: BEvent) => e.tags.some((t) => t[0] === "e" && t[2] === "reply");
  const top = evs.filter((e) => !isReply(e));
  const repliesOf = (id: string) => evs.filter((e) => e.tags.some((t) => t[0] === "e" && t[1] === id && t[2] === "reply"));
  const reacts = (id: string) => s.log.filter((e) => e.kind === K.react && e.tags.some((t) => t[1] === id));
  if (!top.length) return <div className="grid h-40 place-items-center text-sm text-zinc-600">No events yet.</div>;
  const row = (e: BEvent, nested = false) => {
    const who = s.ids.find((i) => i.name === e.actor);
    const isAgent = who?.type === "agent";
    return (
      <div key={e.seq} className={cn("group flex gap-2.5", nested && "ml-9 mt-2")}>
        <div className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", isAgent ? "bg-sky-500/20 text-sky-300" : "bg-emerald-500/20 text-emerald-300")}>{isAgent ? <Bot size={14} /> : <User size={13} />}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-zinc-200">{e.actor}</span>
            {isAgent && <Badge tone="sky"><LinkIcon size={9} />attested by {who?.owner}</Badge>}
            <Badge tone="amber">{KIND_NAME[e.kind]}</Badge>
            <span className="text-zinc-600">{fmtClock(e.ts)}</span>
            <button onClick={() => onInspect(e)} className="text-zinc-600 hover:text-amber-300" title="inspect signed event">⛓ {e.id.slice(0, 6)}</button>
          </div>
          {e.kind === K.patch ? (
            <pre className="mt-1 overflow-x-auto rounded-lg border border-zinc-800 bg-black/50 p-2 text-[11px] text-emerald-300">{e.content}</pre>
          ) : (
            <div className={cn("mt-0.5 whitespace-pre-wrap text-sm leading-relaxed", e.kind === K.ci ? "text-emerald-300" : e.kind === K.approve ? "font-medium text-emerald-300" : e.kind === K.applied ? "inline-flex items-center gap-1 font-medium text-violet-300" : "text-zinc-300")}>
              {e.kind === K.applied && <GitMerge size={14} />}{e.content}
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {reacts(e.id).length > 0 && <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">👍 {reacts(e.id).length} · {reacts(e.id).map((r) => r.actor).join(", ")}</span>}
            {!nested && e.kind === K.chat && (
              <span className="hidden gap-2 text-[11px] text-zinc-600 group-hover:flex">
                <button className="hover:text-white" onClick={() => onReply(e)}>reply</button>
                <button className="hover:text-white" onClick={() => onReact(e)}>👍</button>
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-4">
      {top.map((e) => (
        <div key={e.seq}>
          {row(e)}
          {repliesOf(e.id).map((r) => row(r, true))}
        </div>
      ))}
    </div>
  );
}

function Inspector({ ev, s, onClose }: { ev: BEvent; s: ReturnType<typeof seed>; onClose: () => void }) {
  const who = s.ids.find((i) => i.name === ev.actor);
  const sigOk = !!who && hex(who.secret + ev.id, 32) === ev.sig;
  const idOk = wireId(ev) === ev.id;
  const json = { id: ev.id, pubkey: who?.pub, created_at: ev.ts, kind: ev.kind, tags: [["h", ev.ch], ["prev", ev.prev], ...ev.tags], content: ev.content, sig: ev.sig };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <div className="text-sm font-semibold text-white">Signed event #{ev.seq}</div>
          <button className="ml-auto text-zinc-500 hover:text-white" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="mb-3 flex gap-2">
          <Badge tone={sigOk ? "emerald" : "rose"}>{sigOk ? "✓ signature valid" : "✗ signature invalid"}</Badge>
          <Badge tone={idOk ? "emerald" : "rose"}>{idOk ? "✓ id matches content" : "✗ content tampered"}</Badge>
        </div>
        <Code>{JSON.stringify(json, null, 2)}</Code>
        <p className="mt-3 text-[11px] text-zinc-500">Demo only: ids use a fast non-cryptographic hash and “signatures” are keyed hashes. Real Buzz uses Nostr (NIP-01) Schnorr signatures over SHA-256 ids.</p>
      </div>
    </div>
  );
}
