import { parseDur, tokenize } from "../lib/util";
import { HiveKernel } from "../kernel/authority";
import { REGISTERED_SLASH_COMMANDS } from "../kernel/commands";
import { HiveError, type EffectKind, type Trust } from "../kernel/types";

export interface CliExecContext {
  tenantId: string;
  actor: string;
  /** Map of taskId -> active capability token held by agents in interactive CLI sessions */
  tokenJar: Record<string, string>;
}

export interface CliExecResult {
  ok: boolean;
  status: number;
  lines: string[];
  tokenJar: Record<string, string>;
  data?: unknown;
}

const VALUE_FLAGS = new Set([
  "--from",
  "--trust",
  "--ready",
  "--label",
  "--epoch",
  "--evidence",
  "--sha",
  "--repro",
  "--key",
  "--in",
  "--principal",
  "--user",
  "--agent",
  "--can",
  "--checkpoint",
  "--cap",
  "--hint",
  "--comment",
  "--severity",
  "--area",
  "--channel",
  "--title",
  "--path",
  "--schema",
  "--token",
  "--branch",
  "--diff",
  "--deps",
]);

function parseFlags(tokens: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.startsWith("--")) {
      if (VALUE_FLAGS.has(tk)) {
        flags[tk.slice(2)] = tokens[++i] ?? "";
      } else {
        flags[tk.slice(2)] = true;
      }
    } else {
      pos.push(tk);
    }
  }
  return { flags, pos };
}

export function executeHiveCli(
  kernel: HiveKernel,
  ctx: CliExecContext,
  rawLine: string,
): CliExecResult {
  const line = rawLine.trim();
  const jar = { ...ctx.tokenJar };
  if (!line) {
    return { ok: true, status: 200, lines: [], tokenJar: jar };
  }

  try {
    // Registered /commands (/triage, /approve, /reject, /resume, /ship)
    if (line.startsWith("/")) {
      const res = kernel.executeSlashCommand(ctx.tenantId, ctx.actor, line);
      return {
        ok: true,
        status: 200,
        lines: [`✓ /${res.verb}: ${res.summary}`],
        tokenJar: jar,
        data: res,
      };
    }

    let toks = tokenize(line);
    if (toks[0] === "hive") toks = toks.slice(1);
    const [group, ...rest] = toks;

    switch (group) {
      case undefined:
      case "help":
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          lines: [
            "hive — Fenced, Verified Agent Coordination CLI:",
            "  hive status                                                  workspace summary & incarnation",
            "  hive task list                                               list all tasks, states, epochs & budgets",
            "  hive task create --title \"...\" [--channel dev] [--path payments/x.ts] [--deps 801]",
            "  hive task create --from slack:C04/171.2 --trust external     create task from inbound event",
            "  hive task claim [<id> | --ready <ch>] [--label k=v]          CAS claim -> {epoch, capabilityToken}",
            "  hive task renew <id> [--token hct_...]                       hook-driven lease renewal",
            "  hive patch push <id> --sha <sha> [--diff \"...\"]              push patch to branch room (invalidates old approvals)",
            "  hive task submit <id> [--sha <sha>] [--evidence pr:4412,ci:14/14]",
            "  hive verify <id> --sha <sha> [--repro safari17] [pass|fail]  clean-sandbox independent verification",
            "  hive gate approve <id> --sha <sha>                           SHA-bound signed human approval",
            "  hive gate reject <id> --comment \"...\"                        reject & reopen task with wake",
            "  hive effect run <open-pr|merge|post-slack> --key <idempKey>  fenced idempotent outbox execution",
            "  hive schedule <id> \"prompt\" --in 5m [--no-sync]              enqueue wake timer (0 idle tokens)",
            "  hive tick [minutes]                                          advance sim clock, expire heartbeats & deliver wakes",
            "  hive inbox --since-cursor [--channel dev]                    read compressed unread working-set diff",
            "  hive post <channel> \"text\" [--task 801] [--schema s '{...}'] discussion message (never mutates task state!)",
            "  hive grants list | explain --principal X <ch>/ | create --principal X --can 'security/=read,post' | revoke <id>",
            "  hive log verify [--checkpoint latest]                        verify SHA-256 chain, Ed25519 sigs & Merkle root",
            "  hive search \"<query>\"                                        unified FTS5 search across chat, patches, receipts",
            "",
            "Registered /commands (identical schema in Slack, UI & CLI):",
            ...REGISTERED_SLASH_COMMANDS.map((c) => `  ${c.slash.padEnd(46)} (${c.who})`),
          ],
        };

      case "status": {
        const tasks = kernel.listTasks(ctx.tenantId);
        const ver = kernel.verifyLog(ctx.tenantId, "latest");
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          lines: [
            `tenant:      ${ctx.tenantId}`,
            `incarnation: ${kernel.getIncarnation()}`,
            `actor:       ${ctx.actor}`,
            `tasks:       ${tasks.length} total (${tasks.filter((t) => t.state === "closed").length} verified closed, ${tasks.filter((t) => t.state === "claimed").length} leased)`,
            `audit chain: ${ver.ok ? `✓ ${ver.checkedEvents} signed events verified` : `✗ broken at #${ver.badSeq}: ${ver.reason}`}`,
          ],
        };
      }

      case "task":
      case "tasks": {
        const [sub, ...r2] = rest;
        const { flags, pos } = parseFlags(r2);

        if (!sub || sub === "list") {
          const list = kernel.listTasks(ctx.tenantId);
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            lines: list.map(
              (t) =>
                `#${t.id.padEnd(4)} ${t.state.padEnd(18)} ep=${String(t.leaseEpoch).padEnd(2)} owner=${(t.owner ?? "—").padEnd(9)} $${(t.budgetSpent / 100).toFixed(2)}/$${(t.budgetCapCents / 100).toFixed(2)}  ${t.title}${t.verifiedClose ? ` [${t.verifiedClose}]` : ""}`,
            ),
          };
        }

        if (sub === "create") {
          const channel = String(flags.channel ?? "dev");
          const fromRef = typeof flags.from === "string" ? flags.from : undefined;
          const trust = (typeof flags.trust === "string" ? flags.trust : undefined) as
            | Trust
            | undefined;
          const title =
            typeof flags.title === "string"
              ? flags.title
              : pos[0] ?? `Follow-up from ${fromRef ?? ctx.actor}`;
          const inbound = fromRef
            ? kernel.ingestMessage(ctx.tenantId, {
                source: fromRef.startsWith("github:") ? "github" : "slack",
                principalId: trust === "external" ? "external-reporter" : ctx.actor,
                channel,
                externalRef: fromRef,
                explicitTrust: trust,
                text: title,
              })
            : undefined;
          const deps =
            typeof flags.deps === "string"
              ? flags.deps
                  .split(",")
                  .map((s) => s.trim().replace(/^#/, ""))
                  .filter(Boolean)
              : [];
          const task = kernel.createTask(ctx.tenantId, {
            actor: fromRef ? "ingest" : ctx.actor,
            channel,
            title,
            deps,
            protectedPath: typeof flags.path === "string" ? flags.path : undefined,
            fromInbound: inbound,
            originOperationId: fromRef,
          });
          return {
            ok: true,
            status: 201,
            tokenJar: jar,
            data: task,
            lines: [
              `created task #${task.id} [${task.state}] in ${task.channel}/ (gate=${task.gatePolicy}, trust=${task.trust})`,
            ],
          };
        }

        if (sub === "claim") {
          const readyCh = typeof flags.ready === "string" ? flags.ready : undefined;
          const taskId = pos[0]?.replace(/^#/, "");
          const labelStr = typeof flags.label === "string" ? flags.label : undefined;
          const labelFilter =
            labelStr && labelStr.includes("=")
              ? { key: labelStr.split("=")[0], value: labelStr.split("=")[1] }
              : undefined;
          const claimed = kernel.claimTask(ctx.tenantId, {
            taskId,
            channel: readyCh,
            labelFilter,
            actor: ctx.actor,
          });
          jar[`${ctx.actor}:${claimed.task.id}`] = claimed.token;
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            data: claimed,
            lines: [
              `claimed #${claimed.task.id} "${claimed.task.title}"`,
              `  lease_epoch: ${claimed.epoch} · revision: ${claimed.task.revision}`,
              `  token:       ${claimed.token.slice(0, 38)}…`,
            ],
          };
        }

        if (sub === "renew") {
          const taskId = (pos[0] ?? "").replace(/^#/, "");
          const tok =
            typeof flags.token === "string"
              ? flags.token
              : jar[`${ctx.actor}:${taskId}`] ?? "";
          if (!tok) {
            return {
              ok: false,
              status: 403,
              tokenJar: jar,
              lines: [`error (403): no capability token held by ${ctx.actor} for #${taskId}`],
            };
          }
          const renewed = kernel.renewLease(ctx.tenantId, { taskId, token: tok });
          jar[`${ctx.actor}:${taskId}`] = renewed.token;
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            data: renewed,
            lines: [
              `renewed lease on #${taskId} (epoch ${renewed.task.leaseEpoch}, rev ${renewed.task.revision})`,
            ],
          };
        }

        if (sub === "submit") {
          const taskId = (pos[0] ?? "").replace(/^#/, "");
          const tok =
            typeof flags.token === "string"
              ? flags.token
              : jar[`${ctx.actor}:${taskId}`] ?? "";
          if (!tok) {
            return {
              ok: false,
              status: 403,
              tokenJar: jar,
              lines: [`error (403): capability token required to submit #${taskId}`],
            };
          }
          const evRefs =
            typeof flags.evidence === "string"
              ? flags.evidence.split(",").map((s) => s.trim())
              : ["ci:14/14"];
          const sha = typeof flags.sha === "string" ? flags.sha : undefined;
          const t = kernel.submitTask(ctx.tenantId, {
            taskId,
            token: tok,
            headSha: sha,
            evidenceRefs: evRefs,
          });
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            data: t,
            lines: [
              `submitted #${t.id} (epoch ${t.leaseEpoch}, head=${t.headSha}) → state is now "${t.state}" (awaiting non-author verifier)`,
            ],
          };
        }

        return {
          ok: false,
          status: 400,
          tokenJar: jar,
          lines: ["usage: hive task list|create|claim|renew|submit"],
        };
      }

      case "patch": {
        const [sub, ...r2] = rest;
        const { flags, pos } = parseFlags(r2);
        if (sub !== "push") {
          return { ok: false, status: 400, tokenJar: jar, lines: ["usage: hive patch push <id> --sha <sha>"] };
        }
        const taskId = (pos[0] ?? "").replace(/^#/, "");
        const sha = typeof flags.sha === "string" ? flags.sha : "3fa9c1";
        const diff =
          typeof flags.diff === "string"
            ? flags.diff
            : `diff --git a/payments/checkout.ts b/payments/checkout.ts\n- form.submit()\n+ form.requestSubmit() // Safari 17.4 fix`;
        const tok =
          typeof flags.token === "string"
            ? flags.token
            : jar[`${ctx.actor}:${taskId}`];
        const t = kernel.pushPatch(ctx.tenantId, {
          taskId,
          headSha: sha,
          diff,
          branch: typeof flags.branch === "string" ? flags.branch : undefined,
          token: tok,
          actor: ctx.actor,
        });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: t,
          lines: [
            `pushed patch @ ${t.headSha} to ${t.branchRoom} (task #${t.id} state=${t.state})`,
          ],
        };
      }

      case "verify": {
        const { flags, pos } = parseFlags(rest);
        const taskId = (pos[0] ?? "").replace(/^#/, "");
        const result = pos[1] === "fail" ? "fail" : "pass";
        const tCur = kernel.getTask(ctx.tenantId, taskId);
        const sha = typeof flags.sha === "string" ? flags.sha : tCur.headSha ?? "";
        const out = kernel.verifyTask(ctx.tenantId, {
          actor: ctx.actor,
          taskId,
          headSha: sha,
          result,
          reproName: typeof flags.repro === "string" ? flags.repro : "safari17-repro",
        });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: out,
          lines: [
            `verifier (${ctx.actor}) recorded ${result.toUpperCase()} receipt ${out.evidence.receiptHash.slice(0, 14)}…`,
            `  task #${out.task.id} → state: ${out.task.state}${out.task.verifiedClose ? ` · VerifiedClose: ${out.task.verifiedClose}` : ""}`,
          ],
        };
      }

      case "gate": {
        const [sub, ...r2] = rest;
        const { flags, pos } = parseFlags(r2);
        const taskId = (pos[0] ?? "").replace(/^#/, "");
        if (sub === "approve") {
          const sha = typeof flags.sha === "string" ? flags.sha : undefined;
          const res = kernel.decideGate(ctx.tenantId, {
            actor: ctx.actor,
            taskId,
            headSha: sha,
            decision: "approve",
          });
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            data: res,
            lines: [
              `gate approved by ${ctx.actor} on SHA ${res.approval.headSha}`,
              `  task #${res.task.id} → state: ${res.task.state}${res.task.verifiedClose ? ` · VerifiedClose: ${res.task.verifiedClose}` : ""}`,
            ],
          };
        }
        if (sub === "reject") {
          const res = kernel.decideGate(ctx.tenantId, {
            actor: ctx.actor,
            taskId,
            decision: "reject",
            comment: typeof flags.comment === "string" ? flags.comment : "changes requested",
          });
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            data: res,
            lines: [`gate rejected by ${ctx.actor} → task #${res.task.id} reopened (${res.task.state})`],
          };
        }
        return { ok: false, status: 400, tokenJar: jar, lines: ["usage: hive gate approve|reject <id> [--sha <sha>]"] };
      }

      case "effect": {
        const [sub, ...r2] = rest;
        const { flags, pos } = parseFlags(r2);
        if (sub !== "run") {
          return { ok: false, status: 400, tokenJar: jar, lines: ["usage: hive effect run <open-pr|merge|post-slack> --key <key>"] };
        }
        const effect = (pos[0] ?? "open-pr") as EffectKind;
        const key = typeof flags.key === "string" ? flags.key : "";
        if (!key) {
          return { ok: false, status: 422, tokenJar: jar, lines: ["error (422): --key <idempotency_key> is required"] };
        }
        const taskMatch = /task:([0-9A-Za-z_-]+)/.exec(key);
        const taskId = taskMatch ? taskMatch[1] : undefined;
        const tok =
          typeof flags.token === "string"
            ? flags.token
            : taskId
              ? jar[`${ctx.actor}:${taskId}`]
              : undefined;
        const receipt = kernel.runEffect(ctx.tenantId, {
          key,
          effect,
          taskId,
          token: tok,
          actor: tok ? undefined : ctx.actor,
          args: {
            taskId,
            repo: "acme/www",
            branch: taskId ? `fix/task-${taskId}` : "fix/patch",
            headSha: typeof flags.sha === "string" ? flags.sha : undefined,
          },
        });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: receipt,
          lines: [`outbox [${key}] → confirmed: ${JSON.stringify(receipt)}`],
        };
      }

      case "schedule": {
        const { flags, pos } = parseFlags(rest);
        const taskId = (pos[0] ?? "").replace(/^#/, "");
        const prompt = pos[1] ?? "scheduled follow-up";
        const mins = parseDur(typeof flags.in === "string" ? flags.in : "5m") ?? 5;
        const t = kernel.getTask(ctx.tenantId, taskId);
        const w = kernel.enqueueWake(ctx.tenantId, {
          principal: ctx.actor,
          taskId: t.id,
          channel: t.channel,
          reason: `schedule: ${prompt}`,
          inMs: mins * 60 * 1000,
          noSync: Boolean(flags["no-sync"]),
        });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: w,
          lines: [
            `scheduled wake #${w.id} for @${ctx.actor} on task #${t.id} in ${mins}m${w.noSync ? " (--no-sync)" : ""}`,
          ],
        };
      }

      case "tick": {
        const mins = Number(rest[0] ?? 5);
        const res = kernel.schedulerTick(ctx.tenantId, { advanceMs: mins * 60 * 1000 });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: res,
          lines: [
            `advanced clock +${mins}m`,
            `  expired leases: ${res.expiredTasks.length ? res.expiredTasks.map((x) => "#" + x).join(", ") : "none"}`,
            `  wakes delivered: ${res.deliveries.length ? res.deliveries.map((d) => `@${d.principal} (${d.diffEvents.length} diff events, ${d.compressionRatioPct}% of log)`).join("; ") : "none"}`,
          ],
        };
      }

      case "inbox": {
        const { flags } = parseFlags(rest);
        const ch = typeof flags.channel === "string" ? flags.channel : undefined;
        const diff = kernel.readInboxSinceCursor(ctx.tenantId, ctx.actor, {
          channel: ch,
          advanceCursor: Boolean(flags["since-cursor"]),
        });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: diff,
          lines: [
            `inbox for @${ctx.actor}: cursor ${diff.cursorFrom} → ${diff.cursorTo} (${diff.events.length}/${diff.totalEventsInLog} events = ${diff.compressionRatioPct}% working-set)`,
            ...diff.events.map(
              (e) =>
                `  #${e.seq} [${e.kind}] @${e.actor}${e.taskId ? ` task=#${e.taskId}` : ""}: ${JSON.stringify(e.payload).slice(0, 96)}`,
            ),
          ],
        };
      }

      case "post": {
        const { flags, pos } = parseFlags(rest);
        const channel = pos[0] ?? "dev";
        const text = pos[1] ?? "";
        const schema = typeof flags.schema === "string" ? flags.schema : undefined;
        const data = schema && pos[2] ? (JSON.parse(pos[2]) as unknown) : undefined;
        const ev = kernel.postChannelMessage(ctx.tenantId, {
          actor: ctx.actor,
          channel,
          text,
          schema,
          data,
          noSync: Boolean(flags["no-sync"]),
        });
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          data: ev,
          lines: [
            `posted signed event #${ev.seq} (${ev.id.slice(0, 12)}…) to ${channel}/ (note: chat is a projection; task state unchanged)`,
          ],
        };
      }

      case "grants": {
        const [sub, ...r2] = rest;
        const { flags, pos } = parseFlags(r2);
        if (!sub || sub === "list") {
          const grants = kernel.listGrants(ctx.tenantId);
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            lines: grants.map(
              (g) => `${g.id.padEnd(5)} ${g.principal.padEnd(12)} ${(g.path || "/").padEnd(14)} ${g.can.join(",")}`,
            ),
          };
        }
        if (sub === "explain") {
          const who = String(flags.principal ?? flags.user ?? flags.agent ?? ctx.actor);
          const ch = (pos[0] ?? "dev").replace(/\/$/, "");
          const rRead = kernel.explainAccess(ctx.tenantId, who, ch, "read");
          const rPost = kernel.explainAccess(ctx.tenantId, who, ch, "post");
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            lines: [
              `${who} read ${ch}/  → ${rRead.ok ? "ALLOW" : "DENY "} (${rRead.why})`,
              `${who} post ${ch}/  → ${rPost.ok ? "ALLOW" : "DENY "} (${rPost.why})`,
            ],
          };
        }
        if (sub === "create") {
          const who = String(flags.principal ?? flags.user ?? flags.agent ?? "");
          const canSpec = String(flags.can ?? "");
          const [p, ops] = canSpec.split("=");
          if (!who || !ops) {
            return {
              ok: false,
              status: 422,
              tokenJar: jar,
              lines: ["usage: hive grants create --principal <id> --can 'security/=read,post'"],
            };
          }
          const g = kernel.createGrant(ctx.tenantId, ctx.actor, {
            principal: who,
            path: p,
            can: ops.split(","),
          });
          return {
            ok: true,
            status: 201,
            tokenJar: jar,
            lines: [`created grant ${g.id}: ${g.principal} ${g.path}=${g.can.join(",")}`],
          };
        }
        if (sub === "revoke") {
          kernel.revokeGrant(ctx.tenantId, ctx.actor, pos[0] ?? "");
          return { ok: true, status: 200, tokenJar: jar, lines: [`revoked grant ${pos[0]}`] };
        }
        return { ok: false, status: 400, tokenJar: jar, lines: ["usage: hive grants list|explain|create|revoke"] };
      }

      case "log": {
        const [sub, ...r2] = rest;
        const { flags } = parseFlags(r2);
        if (sub === "checkpoint") {
          const chk = kernel.createCheckpoint(ctx.tenantId);
          return {
            ok: true,
            status: 200,
            tokenJar: jar,
            lines: [
              `checkpoint ${chk.id} created up to seq #${chk.uptoSeq} (merkle=${chk.merkleRoot.slice(0, 16)}…)`,
            ],
          };
        }
        const chkSel =
          typeof flags.checkpoint === "string" ? flags.checkpoint : "latest";
        const ver = kernel.verifyLog(ctx.tenantId, chkSel);
        return {
          ok: ver.ok,
          status: ver.ok ? 200 : 409,
          tokenJar: jar,
          data: ver,
          lines: ver.ok
            ? [
                `✓ verified ${ver.checkedEvents} hash-chained Ed25519-signed events${ver.checkpointVerified ? ` + Merkle checkpoint ${ver.checkpointId}` : ""}`,
              ]
            : [`✗ AUDIT FAILURE at seq #${ver.badSeq}: ${ver.reason}`],
        };
      }

      case "search": {
        const q = rest.join(" ");
        const hits = kernel.searchEvents(ctx.tenantId, q);
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          lines: hits.length
            ? hits.map(
                (e) =>
                  `#${e.seq} [${e.kind}] @${e.actor} (${e.channel ?? "kernel"}): ${JSON.stringify(e.payload).slice(0, 100)}`,
              )
            : ["(no matching events)"],
        };
      }

      case "principals": {
        const ps = kernel.listPrincipals(ctx.tenantId);
        return {
          ok: true,
          status: 200,
          tokenJar: jar,
          lines: ps.map(
            (p) =>
              `${p.kind === "agent" ? "🤖" : "👤"} ${p.id.padEnd(14)} role=${p.role.padEnd(9)} ${p.attestation ? `owner=${p.owner} revoked=${p.attestation.revoked}` : "root"}`,
          ),
        };
      }

      default:
        return {
          ok: false,
          status: 400,
          tokenJar: jar,
          lines: [`unknown hive command "${group}" — run: hive help`],
        };
    }
  } catch (err) {
    if (err instanceof HiveError) {
      return {
        ok: false,
        status: err.status,
        tokenJar: jar,
        lines: [`error (${err.status} ${err.code}): ${err.message}`],
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 500,
      tokenJar: jar,
      lines: [`error: ${msg}`],
    };
  }
}
