import { sha256 } from "./crypto";
import { enforceOutboundDlp } from "./policy";
import type { EffectKind } from "./types";

export interface ConnectorState {
  prs: {
    number: number;
    repo: string;
    branch: string;
    headSha: string;
    title: string;
    taskId?: string;
    idempotencyKey: string;
    merged: boolean;
    mergeSha?: string;
  }[];
  slackPosts: {
    ts: string;
    channel: string;
    text: string;
    idempotencyKey: string;
  }[];
  githubComments: {
    id: string;
    pr: number;
    body: string;
    idempotencyKey: string;
  }[];
  branches: {
    repo: string;
    branch: string;
    room: string;
    idempotencyKey: string;
  }[];
  nextPrNumber: number;
}

export class EffectConnectorHub {
  private byTenant = new Map<string, ConnectorState>();
  /** Test hook: drop the acknowledgement right after performing the external effect once */
  private dropAckOnceKeys = new Set<string>();

  private state(tenantId: string): ConnectorState {
    let s = this.byTenant.get(tenantId);
    if (!s) {
      s = {
        prs: [],
        slackPosts: [],
        githubComments: [],
        branches: [],
        nextPrNumber: 4412,
      };
      this.byTenant.set(tenantId, s);
    }
    return s;
  }

  public armDropAckOnce(idempotencyKey: string) {
    this.dropAckOnceKeys.add(idempotencyKey);
  }

  public inspectTenantEffects(tenantId: string): ConnectorState {
    const s = this.state(tenantId);
    return {
      prs: [...s.prs],
      slackPosts: [...s.slackPosts],
      githubComments: [...s.githubComments],
      branches: [...s.branches],
      nextPrNumber: s.nextPrNumber,
    };
  }

  /**
   * Read-after-write check on external connector before performing side effect.
   * Ensures crash-between-perform-and-ack never creates a duplicate PR/merge/post.
   */
  public findExisting(
    tenantId: string,
    effect: EffectKind,
    args: Record<string, unknown>,
    idempotencyKey: string,
  ): Record<string, unknown> | null {
    const s = this.state(tenantId);
    switch (effect) {
      case "open-pr": {
        const repo = String(args.repo ?? "acme/www");
        const branch = String(args.branch ?? `fix/${args.taskId ?? "task"}`);
        const hit = s.prs.find(
          (p) => p.idempotencyKey === idempotencyKey || (p.repo === repo && p.branch === branch),
        );
        if (!hit) return null;
        return {
          effect: "open-pr",
          prNumber: hit.number,
          url: `https://github.com/${hit.repo}/pull/${hit.number}`,
          repo: hit.repo,
          branch: hit.branch,
          headSha: hit.headSha,
          reconciledViaReadBack: true,
        };
      }
      case "merge": {
        const prNum = Number(args.prNumber ?? 0);
        const taskId = args.taskId ? String(args.taskId) : undefined;
        const hit = s.prs.find(
          (p) =>
            p.merged &&
            (p.number === prNum || (taskId !== undefined && p.taskId === taskId)),
        );
        if (!hit) return null;
        return {
          effect: "merge",
          prNumber: hit.number,
          merged: true,
          mergeSha: hit.mergeSha,
          reconciledViaReadBack: true,
        };
      }
      case "post-slack": {
        const hit = s.slackPosts.find((p) => p.idempotencyKey === idempotencyKey);
        if (!hit) return null;
        return {
          effect: "post-slack",
          channel: hit.channel,
          slackTs: hit.ts,
          reconciledViaReadBack: true,
        };
      }
      case "post-github": {
        const hit = s.githubComments.find((c) => c.idempotencyKey === idempotencyKey);
        if (!hit) return null;
        return {
          effect: "post-github",
          commentId: hit.id,
          prNumber: hit.pr,
          reconciledViaReadBack: true,
        };
      }
      case "open-branch": {
        const branch = String(args.branch ?? "");
        const hit = s.branches.find(
          (b) => b.idempotencyKey === idempotencyKey || b.branch === branch,
        );
        if (!hit) return null;
        return {
          effect: "open-branch",
          repo: hit.repo,
          branch: hit.branch,
          room: hit.room,
          reconciledViaReadBack: true,
        };
      }
    }
  }

  public perform(
    tenantId: string,
    effect: EffectKind,
    args: Record<string, unknown>,
    idempotencyKey: string,
  ): Record<string, unknown> {
    const s = this.state(tenantId);
    let receipt: Record<string, unknown>;

    switch (effect) {
      case "open-pr": {
        const repo = String(args.repo ?? "acme/www");
        const branch = String(args.branch ?? `fix/task-${args.taskId ?? "x"}`);
        const headSha = String(
          args.headSha ?? sha256(`${repo}:${branch}:${idempotencyKey}`).slice(0, 12),
        );
        const title = String(args.title ?? `Fix for task #${args.taskId ?? ""}`);
        enforceOutboundDlp(title);
        const prNumber = s.nextPrNumber++;
        s.prs.push({
          number: prNumber,
          repo,
          branch,
          headSha,
          title,
          taskId: args.taskId ? String(args.taskId) : undefined,
          idempotencyKey,
          merged: false,
        });
        receipt = {
          effect: "open-pr",
          prNumber,
          url: `https://github.com/${repo}/pull/${prNumber}`,
          repo,
          branch,
          headSha,
        };
        break;
      }
      case "merge": {
        const taskId = args.taskId ? String(args.taskId) : undefined;
        const prNumber = Number(args.prNumber ?? 0);
        let pr = s.prs.find(
          (p) => p.number === prNumber || (taskId !== undefined && p.taskId === taskId),
        );
        const headSha = String(args.headSha ?? pr?.headSha ?? sha256(idempotencyKey).slice(0, 12));
        if (!pr) {
          const num = prNumber || s.nextPrNumber++;
          pr = {
            number: num,
            repo: String(args.repo ?? "acme/www"),
            branch: String(args.branch ?? `fix/task-${taskId ?? "x"}`),
            headSha,
            title: String(args.title ?? `Task #${taskId ?? num}`),
            taskId,
            idempotencyKey,
            merged: true,
            mergeSha: sha256(`merge:${num}:${headSha}`).slice(0, 12),
          };
          s.prs.push(pr);
        } else {
          pr.merged = true;
          pr.mergeSha = sha256(`merge:${pr.number}:${headSha}`).slice(0, 12);
        }
        receipt = {
          effect: "merge",
          prNumber: pr.number,
          merged: true,
          headSha,
          mergeSha: pr.mergeSha,
        };
        break;
      }
      case "post-slack": {
        const channel = String(args.channel ?? "#bugs");
        const text = String(args.text ?? "");
        enforceOutboundDlp(text);
        const ts = `179560.${1000 + s.slackPosts.length}`;
        s.slackPosts.push({ ts, channel, text, idempotencyKey });
        receipt = { effect: "post-slack", channel, slackTs: ts };
        break;
      }
      case "post-github": {
        const pr = Number(args.prNumber ?? 4412);
        const body = String(args.body ?? "");
        enforceOutboundDlp(body);
        const id = `gh_cmt_${100 + s.githubComments.length}`;
        s.githubComments.push({ id, pr, body, idempotencyKey });
        receipt = { effect: "post-github", commentId: id, prNumber: pr };
        break;
      }
      case "open-branch": {
        const repo = String(args.repo ?? "acme/www");
        const branch = String(args.branch ?? "fix/safari-pay");
        const room = `branch/${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        s.branches.push({ repo, branch, room, idempotencyKey });
        receipt = { effect: "open-branch", repo, branch, room };
        break;
      }
    }

    if (this.dropAckOnceKeys.has(idempotencyKey)) {
      this.dropAckOnceKeys.delete(idempotencyKey);
      throw new Error(
        `network drop after external ${effect} completed (simulated crash before ack)`,
      );
    }
    return receipt;
  }
}
