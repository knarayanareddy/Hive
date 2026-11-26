/**
 * Live GitHub gateway for the Hive outbox effect kinds:
 *   open-pr · merge · post-github · open-branch
 *
 * Every operation implements read-after-write reconciliation against the
 * GitHub API itself (PR by head branch, PR merged state, comment scan for the
 * idempotency marker, git ref existence) so a retry after a network drop never
 * duplicates the side effect. Tested against a mock GitHub on 127.0.0.1
 * (see tests/integrations.spec.ts) via HIVE_GITHUB_API_URL.
 *
 * Auth: HIVE_GITHUB_TOKEN, or locally via the authenticated `gh` CLI
 * (`gh auth token`) when available. Repo: HIVE_GITHUB_REPO=owner/name.
 *
 * Network failures THROW — the outbox marks the row failed and leaves it
 * retryable. We never silently fall back to the simulated connector for a
 * configured live GitHub.
 */
import { execFileSync } from "node:child_process";
import { enforceOutboundDlp } from "../kernel/policy";
import type { EffectKind } from "../kernel/types";
import { httpSync } from "./httpSync";

export interface GitHubConfig {
  token: string;
  repo: string;
  apiUrl: string;
}

export const GITHUB_EFFECTS: EffectKind[] = ["open-pr", "merge", "post-github", "open-branch"];

export function githubFromEnv(
  env: Record<string, string | undefined> = process.env,
): GitHubConfig | null {
  const repo = env.HIVE_GITHUB_REPO?.trim();
  if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`HIVE_GITHUB_REPO must be "owner/name", got: ${repo}`);
  }
  let token = env.HIVE_GITHUB_TOKEN?.trim();
  if (!token && env.HIVE_GITHUB_USE_GH_CLI !== "0") {
    try {
      token = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      token = undefined;
    }
  }
  if (!repo || !token) return null;
  return { token, repo, apiUrl: (env.HIVE_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "") };
}

export function githubMarker(key: string): string {
  return `<!-- hive-idem:${key} -->`;
}

function sanitizeRoom(branch: string): string {
  return `branch/${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export class GitHubGateway {
  constructor(private readonly cfg: GitHubConfig) {}

  public static handles(effect: EffectKind): boolean {
    return GITHUB_EFFECTS.includes(effect);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private api(method: string, path: string, body?: unknown, timeoutMs = 10_000) {
    return httpSync({
      method,
      url: `${this.cfg.apiUrl}${path}`,
      headers: this.headers(),
      body,
      timeoutMs,
    });
  }

  public findExisting(
    effect: EffectKind,
    args: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> | null {
    switch (effect) {
      case "open-pr": {
        const branch = String(args.branch ?? `fix/${args.taskId ?? "x"}`);
        const owner = this.cfg.repo.split("/")[0];
        const res = this.api(
          "GET",
          `/repos/${this.cfg.repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`,
        );
        if (res.status !== 200) {
          throw new Error(`github pulls list failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        const prs = (res.json ?? []) as Array<Record<string, unknown>>;
        const pr = prs.find((p) => {
          const head = p.head as { ref?: string } | undefined;
          return head?.ref === branch;
        });
        if (!pr) return null;
        const head = pr.head as { sha?: string } | undefined;
        return {
          effect: "open-pr",
          prNumber: pr.number,
          url: pr.html_url,
          repo: this.cfg.repo,
          branch,
          headSha: head?.sha,
          reconciledViaReadBack: true,
          via: "github-api",
        };
      }
      case "merge": {
        let prNumber = Number(args.prNumber ?? 0);
        if (!prNumber && args.branch) {
          const branch = String(args.branch);
          const owner = this.cfg.repo.split("/")[0];
          const list = this.api(
            "GET",
            `/repos/${this.cfg.repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`,
          );
          if (list.status === 200) {
            const prs = (list.json ?? []) as Array<Record<string, unknown>>;
            const hit = prs[0];
            if (hit) prNumber = Number(hit.number ?? 0);
          }
        }
        if (!prNumber) return null;
        const res = this.api("GET", `/repos/${this.cfg.repo}/pulls/${prNumber}`);
        if (res.status !== 200) {
          throw new Error(`github pr read failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        const pr = res.json as Record<string, unknown> | null;
        if (!pr?.merged) return null;
        return {
          effect: "merge",
          prNumber,
          merged: true,
          mergeSha: pr.merge_commit_sha,
          reconciledViaReadBack: true,
          via: "github-api",
        };
      }
      case "post-github": {
        const pr = Number(args.prNumber ?? 0);
        if (!pr) return null;
        const res = this.api("GET", `/repos/${this.cfg.repo}/issues/${pr}/comments?per_page=100`);
        if (res.status !== 200) {
          throw new Error(`github comments list failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        const marker = githubMarker(key);
        const comments = (res.json ?? []) as Array<Record<string, unknown>>;
        const hit = comments.find((c) => String(c.body ?? "").includes(marker));
        if (!hit) return null;
        return {
          effect: "post-github",
          commentId: String(hit.id),
          prNumber: pr,
          reconciledViaReadBack: true,
          via: "github-api",
        };
      }
      case "open-branch": {
        const branch = String(args.branch ?? "");
        if (!branch) return null;
        const res = this.api("GET", `/repos/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        if (res.status === 404) return null;
        if (res.status !== 200) {
          throw new Error(`github ref read failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        return {
          effect: "open-branch",
          repo: this.cfg.repo,
          branch,
          room: String(args.room ?? sanitizeRoom(branch)),
          reconciledViaReadBack: true,
          via: "github-api",
        };
      }
      default:
        return null;
    }
  }

  public perform(
    effect: EffectKind,
    args: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    switch (effect) {
      case "open-pr": {
        const branch = String(args.branch ?? `fix/${args.taskId ?? "x"}`);
        const title = String(args.title ?? `Fix for task #${args.taskId ?? ""}`);
        enforceOutboundDlp(title);
        const base = String(args.base ?? "main");
        const headSha = args.headSha ? String(args.headSha) : undefined;
        const body = `Hive task #${args.taskId ?? "?"} — automated by the Hive authority kernel.${githubMarker(key) ? `\n\n${githubMarker(key)}` : ""}`;
        const res = this.api("POST", `/repos/${this.cfg.repo}/pulls`, {
          title,
          head: branch,
          base,
          body,
        });
        if (res.status === 422) {
          // PR already exists for this head → reconcile instead of failing.
          const existing = this.findExisting("open-pr", args, key);
          if (existing) return existing;
        }
        if (res.status !== 201) {
          throw new Error(`github open-pr failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        const pr = res.json as Record<string, unknown>;
        const head = pr.head as { sha?: string; ref?: string } | undefined;
        return {
          effect: "open-pr",
          prNumber: pr.number,
          url: pr.html_url,
          repo: this.cfg.repo,
          branch: head?.ref ?? branch,
          headSha: head?.sha ?? headSha,
          via: "github-api",
        };
      }
      case "merge": {
        let prNumber = Number(args.prNumber ?? 0);
        if (!prNumber && args.branch) {
          const branch = String(args.branch);
          const owner = this.cfg.repo.split("/")[0];
          const list = this.api(
            "GET",
            `/repos/${this.cfg.repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`,
          );
          if (list.status === 200) {
            const prs = (list.json ?? []) as Array<Record<string, unknown>>;
            const hit = prs.find((p) => p.state === "open") ?? prs[0];
            if (hit) prNumber = Number(hit.number ?? 0);
          }
        }
        if (!prNumber) throw new Error("github merge requires args.prNumber or a resolvable open PR for args.branch");
        const res = this.api("PUT", `/repos/${this.cfg.repo}/pulls/${prNumber}/merge`, {
          merge_method: String(args.mergeMethod ?? "squash"),
          ...(args.headSha ? { sha: String(args.headSha) } : {}),
        });
        if (res.status !== 200) {
          throw new Error(`github merge refused (${res.status}): ${res.text.slice(0, 300)}`);
        }
        const payload = res.json as Record<string, unknown>;
        return {
          effect: "merge",
          prNumber,
          merged: true,
          headSha: args.headSha ? String(args.headSha) : undefined,
          mergeSha: payload.sha,
          via: "github-api",
        };
      }
      case "post-github": {
        const pr = Number(args.prNumber ?? 0);
        if (!pr) throw new Error("github comment requires args.prNumber");
        const body = String(args.body ?? "");
        enforceOutboundDlp(body);
        const res = this.api("POST", `/repos/${this.cfg.repo}/issues/${pr}/comments`, {
          body: `${body}\n\n${githubMarker(key)}`,
        });
        if (res.status !== 201) {
          throw new Error(`github comment failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        const comment = res.json as Record<string, unknown>;
        return {
          effect: "post-github",
          commentId: String(comment.id),
          prNumber: pr,
          via: "github-api",
        };
      }
      case "open-branch": {
        const branch = String(args.branch ?? "");
        if (!branch) throw new Error("github open-branch requires args.branch");
        const base = String(args.base ?? "main");
        const refRes = this.api("GET", `/repos/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(base)}`);
        if (refRes.status !== 200) {
          throw new Error(`github base ref read failed (${refRes.status}): ${refRes.text.slice(0, 300)}`);
        }
        const baseSha = (refRes.json as { object?: { sha?: string } } | null)?.object?.sha;
        if (!baseSha) throw new Error("github base ref returned no sha");
        const res = this.api("POST", `/repos/${this.cfg.repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });
        if (res.status === 422) {
          const existing = this.findExisting("open-branch", args, key);
          if (existing) return existing;
        }
        if (res.status !== 201) {
          throw new Error(`github open-branch failed (${res.status}): ${res.text.slice(0, 300)}`);
        }
        return {
          effect: "open-branch",
          repo: this.cfg.repo,
          branch,
          room: sanitizeRoom(branch),
          via: "github-api",
        };
      }
      default:
        throw new Error(`github gateway does not handle effect: ${effect}`);
    }
  }
}
