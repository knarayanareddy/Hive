import { parseDur, tokenize } from "../lib/util";

export type MsgKind = "human" | "agent" | "slack" | "github" | "system";
export interface Msg {
  id: string;
  author: string;
  kind: MsgKind;
  text: string;
  ts: number;
  schema?: string;
  data?: Record<string, unknown>;
  sync?: "slack" | "github" | "internal" | "none";
}
export interface Task {
  state: "open" | "claimed" | "done";
  owner?: string;
  leaseUntil?: number;
  deps: string[];
}
export interface Thread {
  id: string;
  channel: string;
  title: string;
  labels: Record<string, string>;
  task?: Task;
  msgs: Msg[];
  origin: "slack" | "github" | "board";
}
export interface Grant {
  id: string;
  principal: string;
  path: string;
  can: string[];
}
export interface Watcher {
  id: string;
  tail: string;
  agent: string;
  enabled: boolean;
}
export interface Sched {
  id: string;
  thread: string;
  at: number;
  prompt: string;
  agent: string;
  noSync: boolean;
  fired: boolean;
}
export interface BEvt {
  id: number;
  ts: number;
  actor: string;
  op: string;
  target: string;
}
export interface BState {
  now: number;
  threads: Thread[];
  grants: Grant[];
  watchers: Watcher[];
  scheds: Sched[];
  events: BEvt[];
  nextThread: number;
  nextGrant: number;
  nextSched: number;
  nextEvt: number;
}

export const CHANNELS = ["dev", "prs", "incidents", "security"];
export const ACTORS = [
  { name: "you", kind: "human", harness: "you@acme.com" },
  { name: "fixer", kind: "agent", harness: "Claude Code" },
  { name: "reviewer", kind: "agent", harness: "Codex" },
  { name: "sec-scan", kind: "agent", harness: "Mastra" },
] as const;

export const SCHEMAS: Record<string, { description: string; required: string[]; enums: Record<string, string[]> }> = {
  "security-finding@1": {
    description: "A security finding reported by an agent.",
    required: ["repository", "severity", "status"],
    enums: { severity: ["low", "medium", "high", "critical"], status: ["open", "triaged", "fixed"] },
  },
};

let mid = 1;
const nm = () => "m" + mid++;

const sys = (text: string, now: number): Msg => ({ id: nm(), author: "board", kind: "system", text, ts: now });

export function initialBoard(): BState {
  const t = (
    id: string,
    channel: string,
    title: string,
    labels: Record<string, string>,
    origin: Thread["origin"],
    task: Task | undefined,
    msgs: Omit<Msg, "id">[],
  ): Thread => ({ id, channel, title, labels, origin, task, msgs: msgs.map((m) => ({ ...m, id: nm() })) });
  return {
    now: 0,
    nextThread: 830,
    nextGrant: 8,
    nextSched: 1,
    nextEvt: 1,
    threads: [
      t("801", "dev", "Checkout button unresponsive on Safari 17", { kind: "bug", status: "ready" }, "slack", { state: "open", deps: [] }, [
        { author: "dana (Slack)", kind: "slack", text: "Hey team — checkout 'Pay now' button does nothing on Safari 17.4. Repro: add item → checkout → click.", ts: -42, sync: "slack" },
      ]),
      t("803", "dev", "Review fix for #801", { kind: "review", status: "blocked" }, "board", { state: "open", deps: ["801"] }, [
        { author: "board", kind: "system", text: "Task depends on #801. It becomes claimable once #801 is complete.", ts: -40 },
      ]),
      t("804", "dev", "Flaky e2e: cart-persistence.spec", { kind: "bug", status: "ready" }, "board", { state: "open", deps: [] }, [
        { author: "you", kind: "human", text: "Fails ~1 in 8 runs on CI. Probably a race on localStorage hydration.", ts: -30, sync: "none" },
      ]),
      t("810", "security", "SQL injection risk in /api/search", { kind: "finding", status: "triaged" }, "board", { state: "open", deps: [] }, [
        { author: "sec-scan", kind: "agent", text: "Unsanitised `q` param reaches raw query builder.", ts: -90, schema: "security-finding@1", data: { repository: "acme/web", severity: "high", status: "open" } },
      ]),
      t("812", "prs", "PR #4398: add retry to webhook sender", { kind: "pr", status: "in-review", pr: "4398" }, "github", undefined, [
        { author: "maria (GitHub)", kind: "github", text: "Opened PR #4398 — adds exponential backoff to webhook sender.", ts: -60, sync: "github" },
      ]),
      t("820", "incidents", "Elevated 5xx on edge (eu-west)", { kind: "incident", status: "monitoring" }, "board", undefined, [
        { author: "you", kind: "human", text: "Error rate 2.4% since 08:41. Mitigated by rolling back 2 canaries.", ts: -18, sync: "none" },
      ]),
    ],
    grants: [
      { id: "g1", principal: "everyone", path: "dev/", can: ["all"] },
      { id: "g2", principal: "everyone", path: "prs/", can: ["all"] },
      { id: "g3", principal: "everyone", path: "incidents/", can: ["all"] },
      { id: "g4", principal: "everyone", path: "security/", can: ["none"] },
      { id: "g5", principal: "you", path: "security/", can: ["all"] },
      { id: "g6", principal: "sec-scan", path: "security/", can: ["read", "post"] },
      { id: "g7", principal: "you", path: "", can: ["all"] },
    ],
    watchers: [
      { id: "w1", tail: "dev", agent: "fixer", enabled: true },
      { id: "w2", tail: "prs", agent: "reviewer", enabled: true },
      { id: "w3", tail: "security", agent: "sec-scan", enabled: false },
    ],
    scheds: [],
    events: [],
  };
}

export type Action =
  | { t: "thread"; thread: Thread; actor: string }
  | { t: "msg"; thread: string; msg: Omit<Msg, "id" | "ts">; actor: string }
  | { t: "claim"; thread: string; agent: string; lease: number }
  | { t: "renew"; thread: string; lease: number; actor: string }
  | { t: "complete"; thread: string; agent: string; text: string }
  | { t: "label"; thread: string; key: string; val: string; actor: string }
  | { t: "sched"; sched: Omit<Sched, "id" | "fired" | "at"> & { inMin: number } }
  | { t: "tick"; mins: number }
  | { t: "grant"; principal: string; path: string; can: string[]; actor: string }
  | { t: "revoke"; id: string; actor: string }
  | { t: "watcher"; id: string }
  | { t: "reset" };

function addEvt(s: BState, actor: string, op: string, target: string): Pick<BState, "events" | "nextEvt"> {
  const e = { id: s.nextEvt, ts: s.now, actor, op, target };
  return { events: [e, ...s.events].slice(0, 80), nextEvt: s.nextEvt + 1 };
}

export function boardReducer(s: BState, a: Action): BState {
  switch (a.t) {
    case "reset":
      return initialBoard();
    case "thread":
      return { ...s, threads: [...s.threads, a.thread], nextThread: s.nextThread + 1, ...addEvt(s, a.actor, "thread.create", `#${a.thread.id} in ${a.thread.channel}`) };
    case "msg": {
      const threads = s.threads.map((t) => {
        if (t.id !== a.thread) return t;
        const sync = a.msg.sync ?? (t.origin === "board" ? "none" : t.origin);
        return { ...t, msgs: [...t.msgs, { ...a.msg, sync, id: nm(), ts: s.now }] };
      });
      return { ...s, threads, ...addEvt(s, a.actor, "message.post", `#${a.thread}`) };
    }
    case "claim": {
      const threads = s.threads.map((t) =>
        t.id === a.thread && t.task
          ? {
              ...t,
              labels: { ...t.labels, status: "in-progress" },
              task: { ...t.task, state: "claimed" as const, owner: a.agent, leaseUntil: s.now + a.lease },
              msgs: [...t.msgs, sys(`@${a.agent} claimed this task (lease ${a.lease}m).`, s.now)],
            }
          : t,
      );
      return { ...s, threads, ...addEvt(s, a.agent, "task.claim", `#${a.thread}`) };
    }
    case "renew": {
      const threads = s.threads.map((t) =>
        t.id === a.thread && t.task && t.task.state === "claimed"
          ? {
              ...t,
              task: { ...t.task, leaseUntil: s.now + a.lease },
              msgs: [...t.msgs, sys(`Lease renewed by @${a.actor} for ${a.lease}m.`, s.now)],
            }
          : t,
      );
      return { ...s, threads, ...addEvt(s, a.actor, "task.renew", `#${a.thread}`) };
    }
    case "complete": {
      const threads = s.threads.map((t) => {
        if (t.id !== a.thread || !t.task) return t;
        const sync: Msg["sync"] = t.origin === "board" ? "none" : t.origin;
        return {
          ...t,
          labels: { ...t.labels, status: "done" },
          task: { ...t.task, state: "done" as const, leaseUntil: undefined },
          msgs: [
            ...t.msgs,
            { id: nm(), author: a.agent, kind: "agent" as const, text: a.text, ts: s.now, sync },
            sys(`Task completed by @${a.agent}.`, s.now),
          ],
        };
      });
      // unblock dependants
      const done = new Set(threads.filter((t) => t.task?.state === "done").map((t) => t.id));
      const th2 = threads.map((t) =>
        t.task && t.task.state === "open" && t.task.deps.length && t.task.deps.every((d) => done.has(d)) && t.labels.status === "blocked"
          ? { ...t, labels: { ...t.labels, status: "ready" }, msgs: [...t.msgs, sys(`Dependencies satisfied (#${t.task.deps.join(", #")}). Task is now ready.`, s.now)] }
          : t,
      );
      return { ...s, threads: th2, ...addEvt(s, a.agent, "task.complete", `#${a.thread}`) };
    }
    case "label":
      return {
        ...s,
        threads: s.threads.map((t) => (t.id === a.thread ? { ...t, labels: { ...t.labels, [a.key]: a.val } } : t)),
        ...addEvt(s, a.actor, "label.set", `#${a.thread} ${a.key}=${a.val}`),
      };
    case "sched": {
      const sc: Sched = {
        id: "s" + s.nextSched,
        thread: a.sched.thread,
        at: s.now + a.sched.inMin,
        prompt: a.sched.prompt,
        agent: a.sched.agent,
        noSync: a.sched.noSync,
        fired: false,
      };
      return { ...s, scheds: [...s.scheds, sc], nextSched: s.nextSched + 1, ...addEvt(s, a.sched.agent, "schedule.create", `#${a.sched.thread} in ${a.sched.inMin}m`) };
    }
    case "tick": {
      const now = s.now + a.mins;
      let events = s.events;
      let nextEvt = s.nextEvt;
      const push = (actor: string, op: string, target: string) => {
        events = [{ id: nextEvt++, ts: now, actor, op, target }, ...events].slice(0, 80);
      };
      let threads = s.threads.map((t) => {
        if (t.task?.state === "claimed" && t.task.leaseUntil !== undefined && t.task.leaseUntil <= now) {
          push("board", "lease.expire", `#${t.id} (was @${t.task.owner})`);
          return {
            ...t,
            labels: { ...t.labels, status: "ready" },
            task: { ...t.task, state: "open" as const, owner: undefined, leaseUntil: undefined },
            msgs: [...t.msgs, sys(`Lease for @${t.task.owner} expired — task released back to the queue.`, now)],
          };
        }
        return t;
      });
      const scheds = s.scheds.map((sc) => {
        if (!sc.fired && sc.at <= now) {
          threads = threads.map((t) =>
            t.id === sc.thread
              ? {
                  ...t,
                  msgs: [
                    ...t.msgs,
                    {
                      id: nm(),
                      author: sc.agent,
                      kind: "agent" as const,
                      text: `⏰ Follow-up woke me: "${sc.prompt}" → Checked: 14/14 CI checks passing ✅`,
                      ts: now,
                      sync: sc.noSync ? ("internal" as const) : t.origin === "board" ? ("none" as const) : t.origin,
                    },
                  ],
                }
              : t,
          );
          push(sc.agent, "schedule.fire", `#${sc.thread}`);
          return { ...sc, fired: true };
        }
        return sc;
      });
      return { ...s, now, threads, scheds, events, nextEvt };
    }
    case "grant": {
      const g: Grant = { id: "g" + s.nextGrant, principal: a.principal, path: a.path, can: a.can };
      return { ...s, grants: [...s.grants, g], nextGrant: s.nextGrant + 1, ...addEvt(s, a.actor, "grant.create", `${a.principal} ${a.path}=${a.can.join(",")}`) };
    }
    case "revoke":
      return { ...s, grants: s.grants.filter((g) => g.id !== a.id), ...addEvt(s, a.actor, "grant.revoke", a.id) };
    case "watcher":
      return { ...s, watchers: s.watchers.map((w) => (w.id === a.id ? { ...w, enabled: !w.enabled } : w)) };
  }
}

// ---------- permissions ----------
export function explain(grants: Grant[], principal: string, channel: string, op: string) {
  const path = channel + "/";
  const spec = (g: Grant) => (g.principal === "everyone" ? 0 : 1);
  const m = grants
    .filter((g) => path.startsWith(g.path) && (g.principal === principal || g.principal === "everyone"))
    .sort((a, b) => b.path.length - a.path.length || spec(b) - spec(a));
  if (!m.length) return { ok: false, why: `no grant matches ${principal} on ${path}`, grant: undefined as Grant | undefined };
  const g = m[0];
  const ok = g.can.includes("all") || g.can.includes(op);
  return { ok, why: `${g.id}: ${g.principal} ${g.path || "/"}=${g.can.join(",")}`, grant: g };
}

export function isReady(s: BState, t: Thread) {
  if (!t.task || t.task.state !== "open") return false;
  return t.task.deps.every((d) => s.threads.find((x) => x.id === d)?.task?.state === "done");
}

// ---------- schema validation ----------
export function validate(schema: string, data: unknown): string | null {
  const sc = SCHEMAS[schema];
  if (!sc) return `unknown schema ${schema}`;
  if (typeof data !== "object" || data === null) return "payload must be a JSON object";
  const d = data as Record<string, unknown>;
  for (const r of sc.required) if (!(r in d)) return `missing required field "${r}"`;
  for (const [k, vals] of Object.entries(sc.enums)) if (k in d && !vals.includes(String(d[k]))) return `field "${k}" must be one of ${vals.join("|")}`;
  return null;
}

// ---------- CLI ----------
export interface CmdResult {
  out: string[];
  actions: Action[];
  wake: { agent: string; thread: string; reason: string }[];
}

const VALUE_FLAGS = new Set(["--lease", "--in", "--label", "--wait", "--schema", "--user", "--can", "--ready", "--agent", "--project", "--environment"]);

function parseArgs(toks: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.startsWith("--")) {
      if (VALUE_FLAGS.has(tk)) flags[tk] = toks[++i] ?? "";
      else flags[tk] = true;
    } else pos.push(tk);
  }
  return { flags, pos };
}

const tid = (x?: string) => (x ? x.replace(/^#/, "") : "");

export function runCommand(s: BState, actor: string, line: string): CmdResult {
  const res: CmdResult = { out: [], actions: [], wake: [] };
  const err = (m: string) => {
    res.out.push("error: " + m);
    return res;
  };
  let toks = tokenize(line.trim());
  if (!toks.length) return res;
  if (toks[0] === "vercel") toks = toks.slice(1);
  if (toks[0] === "board" || toks[0] === "vb") toks = toks.slice(1);
  const [cmd, ...rest] = toks;
  const find = (id: string) => s.threads.find((t) => t.id === tid(id));
  const can = (ch: string, op: string) => explain(s.grants, actor, ch, op);

  switch (cmd) {
    case undefined:
    case "help":
      res.out.push(
        "vercel board — commands:",
        "  threads [channel]                                   list threads you can read",
        "  tasks claim --ready <channel> [--label k=v]         claim next ready task",
        "  tasks renew <id> --lease 1h                         extend your lease",
        "  tasks complete <id> \"text\"                          settle the task",
        "  post <id|channel> \"text\" [--schema name '{json}']   reply, or open a new thread",
        "  label <id> key=value                                set a label",
        "  schedule <id> \"prompt\" --in 5m [--no-sync]          wake yourself later",
        "  grants list | explain --user X <channel> | create --user X --can 'path/=read,post' | revoke gN",
        "  schemas [inspect <name>]    inspect              registry / activity feed",
      );
      return res;
    case "threads": {
      const ch = rest[0];
      const list = s.threads.filter((t) => (!ch || t.channel === ch) && can(t.channel, "read").ok);
      if (!list.length) res.out.push("(no threads visible)");
      for (const t of list) {
        const st = t.task ? (t.task.state === "open" ? (isReady(s, t) ? "ready" : "blocked") : t.task.state) : "—";
        res.out.push(`#${t.id.padEnd(4)} ${t.channel.padEnd(9)} ${st.padEnd(8)} ${t.title}`);
      }
      return res;
    }
    case "tasks": {
      const [sub, ...r2] = rest;
      const { flags, pos } = parseArgs(r2);
      if (sub === "claim") {
        const ch = String(flags["--ready"] ?? "");
        if (!ch) return err("usage: tasks claim --ready <channel>");
        const g = can(ch, "post");
        if (!g.ok) return err(`403 forbidden — ${actor} cannot post to ${ch}/ (${g.why})`);
        const lab = typeof flags["--label"] === "string" ? flags["--label"].split("=") : null;
        const cand = s.threads.find((t) => t.channel === ch && isReady(s, t) && (!lab || t.labels[lab[0]] === lab[1]));
        if (!cand) {
          res.out.push(`no ready task in ${ch}${flags["--wait"] ? ` (waited ${flags["--wait"]})` : ""}`);
          return res;
        }
        res.actions.push({ t: "claim", thread: cand.id, agent: actor, lease: 30 });
        res.out.push(`claimed #${cand.id} "${cand.title}" — lease 30m`);
        return res;
      }
      if (sub === "renew") {
        const th = find(pos[0]);
        if (!th?.task) return err("no such task");
        if (th.task.state !== "claimed") return err("task is not claimed");
        if (th.task.owner !== actor) return err(`409 not the lease holder (owner: @${th.task.owner})`);
        const m = parseDur(String(flags["--lease"] ?? "30m")) ?? 30;
        res.actions.push({ t: "renew", thread: th.id, lease: m, actor });
        res.out.push(`lease renewed on #${th.id} for ${m}m`);
        return res;
      }
      if (sub === "complete") {
        const th = find(pos[0]);
        if (!th?.task) return err("no such task");
        if (th.task.state !== "claimed") return err("task is not claimed");
        if (th.task.owner !== actor) return err(`409 not the lease holder (owner: @${th.task.owner})`);
        res.actions.push({ t: "complete", thread: th.id, agent: actor, text: pos[1] ?? "Done." });
        res.out.push(`completed #${th.id}`);
        const dep = s.threads.filter((x) => x.task?.deps.includes(th.id));
        if (dep.length) res.out.push(`unblocked: ${dep.map((d) => "#" + d.id).join(", ")}`);
        return res;
      }
      return err("usage: tasks claim|renew|complete");
    }
    case "post": {
      const { flags, pos } = parseArgs(rest);
      const target = pos[0];
      if (!target) return err("usage: post <id|channel> \"text\"");
      const schema = typeof flags["--schema"] === "string" ? flags["--schema"] : undefined;
      let text = pos[1] ?? "";
      let data: Record<string, unknown> | undefined;
      if (schema) {
        try {
          data = JSON.parse(text);
        } catch {
          return err("payload is not valid JSON");
        }
        const bad = validate(schema, data);
        if (bad) return err(`422 schema validation failed (${schema}): ${bad}`);
        text = String((data as Record<string, unknown>).summary ?? `Structured ${schema} posted.`);
      }
      const kind: MsgKind = ACTORS.find((x) => x.name === actor)?.kind === "agent" ? "agent" : "human";
      if (CHANNELS.includes(target)) {
        const g = can(target, "post");
        if (!g.ok) return err(`403 forbidden — ${actor} cannot post to ${target}/ (${g.why})`);
        const id = String(s.nextThread);
        const th: Thread = {
          id,
          channel: target,
          title: (text.length > 56 ? text.slice(0, 54) + "…" : text) || "Untitled",
          labels: { kind: schema ? "finding" : "note", status: schema ? "triaged" : "open" },
          origin: "board",
          task: schema ? { state: "open", deps: [] } : undefined,
          msgs: [{ id: nm(), author: actor, kind, text, ts: s.now, schema, data, sync: "none" }],
        };
        res.actions.push({ t: "thread", thread: th, actor });
        res.out.push(`created #${id} in ${target}` + (schema ? ` (validated ${schema})` : ""));
        for (const w of s.watchers) if (w.enabled && w.tail === target && w.agent !== actor) res.wake.push({ agent: w.agent, thread: id, reason: `watcher ${w.id} on ${target}/` });
        return res;
      }
      const th = find(target);
      if (!th) return err(`no such thread or channel: ${target}`);
      const g = can(th.channel, "post");
      if (!g.ok) return err(`403 forbidden — ${actor} cannot post to ${th.channel}/ (${g.why})`);
      res.actions.push({ t: "msg", thread: th.id, actor, msg: { author: actor, kind, text, schema, data, sync: flags["--no-sync"] ? "internal" : undefined } });
      res.out.push(`posted to #${th.id}`);
      if (kind === "human")
        for (const w of s.watchers) if (w.enabled && w.tail === th.channel && w.agent !== actor) res.wake.push({ agent: w.agent, thread: th.id, reason: `watcher ${w.id}: new reply in ${th.channel}/` });
      return res;
    }
    case "label": {
      const th = find(rest[0]);
      const kv = (rest[1] ?? "").split("=");
      if (!th || kv.length !== 2) return err("usage: label <id> key=value");
      if (!can(th.channel, "post").ok) return err(`403 forbidden on ${th.channel}/`);
      res.actions.push({ t: "label", thread: th.id, key: kv[0], val: kv[1], actor });
      res.out.push(`#${th.id} ${kv[0]}=${kv[1]}`);
      return res;
    }
    case "schedule": {
      const { flags, pos } = parseArgs(rest);
      const th = find(pos[0]);
      if (!th) return err("no such thread");
      const m = parseDur(String(flags["--in"] ?? ""));
      if (!m) return err("usage: schedule <id> \"prompt\" --in 5m");
      res.actions.push({ t: "sched", sched: { thread: th.id, prompt: pos[1] ?? "check in", agent: actor, noSync: !!flags["--no-sync"], inMin: m } });
      res.out.push(`scheduled follow-up on #${th.id} in ${m}m${flags["--no-sync"] ? " (board-only, --no-sync)" : ""}`);
      return res;
    }
    case "grants": {
      const [sub, ...r2] = rest;
      const { flags, pos } = parseArgs(r2);
      if (sub === "list" || !sub) {
        for (const g of s.grants) res.out.push(`${g.id.padEnd(4)} ${g.principal.padEnd(10)} ${(g.path || "/").padEnd(12)} ${g.can.join(",")}`);
        return res;
      }
      if (sub === "explain") {
        const who = String(flags["--user"] ?? flags["--agent"] ?? actor);
        const ch = (pos[0] ?? "dev").replace(/\/$/, "");
        for (const op of ["read", "post"]) {
          const e = explain(s.grants, who, ch, op);
          res.out.push(`${who} ${op.padEnd(4)} ${ch}/  →  ${e.ok ? "ALLOW" : "DENY "}   (${e.why})`);
        }
        return res;
      }
      if (sub === "create") {
        if (actor !== "you") return err("403 only admins can create grants");
        const who = flags["--everyone"] ? "everyone" : String(flags["--user"] ?? flags["--agent"] ?? "");
        const spec = String(flags["--can"] ?? "");
        const [path, ops] = spec.split("=");
        if (!who || !ops) return err("usage: grants create --user X --can 'security/=read,post'");
        const norm = who.includes("@") ? who.split("@")[0] : who;
        res.actions.push({ t: "grant", principal: norm, path: path ?? "", can: ops.split(","), actor });
        res.out.push(`grant created: ${norm} ${path}=${ops}`);
        return res;
      }
      if (sub === "revoke") {
        if (actor !== "you") return err("403 only admins can revoke grants");
        if (!s.grants.find((g) => g.id === pos[0])) return err("no such grant");
        res.actions.push({ t: "revoke", id: pos[0], actor });
        res.out.push(`revoked ${pos[0]}`);
        return res;
      }
      return err("usage: grants list|explain|create|revoke");
    }
    case "schemas": {
      if (rest[0] === "inspect") {
        const sc = SCHEMAS[rest[1]];
        if (!sc) return err("unknown schema");
        res.out.push(JSON.stringify({ name: rest[1], ...sc }, null, 2));
        return res;
      }
      for (const [k, v] of Object.entries(SCHEMAS)) res.out.push(`${k}  — ${v.description}`);
      return res;
    }
    case "inspect": {
      if (!s.events.length) res.out.push("(no activity yet)");
      for (const e of s.events.slice(0, 10)) res.out.push(`#${String(e.id).padStart(3, "0")} ${e.actor.padEnd(9)} ${e.op.padEnd(16)} ${e.target}`);
      return res;
    }
    default:
      return err(`unknown command "${cmd}" — try: help`);
  }
}
