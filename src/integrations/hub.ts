/**
 * Live-aware effect hub for the Hive outbox.
 *
 * Resolution (HIVE_INTEGRATIONS):
 *   - "simulation"  → always the in-memory simulated connector (default dev)
 *   - "live"        → both categories must resolve from the environment or this
 *                     throws at startup (fail fast, never silently simulate)
 *   - "auto" (dflt) → per category: live when credentials resolve, else simulation
 *
 * Per-category credentials:
 *   github → HIVE_GITHUB_REPO=owner/name + HIVE_GITHUB_TOKEN
 *            (or local `gh auth token` unless HIVE_GITHUB_USE_GH_CLI=0)
 *            HIVE_GITHUB_API_URL overrides the API base (GitHub Enterprise / tests)
 *   slack  → HIVE_SLACK_WEBHOOK_URL  (incoming webhook)
 *            or HIVE_SLACK_BOT_TOKEN + HIVE_SLACK_CHANNEL (+ HIVE_SLACK_API_URL for tests)
 *
 * A configured-live category NEVER falls back to simulation on network failure —
 * the outbox row goes 'failed' and stays retryable. Falling back would silently
 * fake the side effect.
 */
import { EffectConnectorHub } from "../kernel/outbox";
import type { EffectKind } from "../kernel/types";
import { GitHubGateway, githubFromEnv } from "./github";
import { SlackGateway, slackFromEnv } from "./slack";
import { EffectLedger } from "./ledger";

export type IntegrationModeSetting = "auto" | "live" | "simulation";

export interface ResolvedIntegrations {
  mode: IntegrationModeSetting;
  github: GitHubGateway | null;
  githubReason: string;
  githubApiUrl: string | null;
  slack: SlackGateway | null;
  slackReason: string;
  ledgerPath: string;
}

export function modeSetting(env: NodeJS.ProcessEnv = process.env): IntegrationModeSetting {
  const raw = (env.HIVE_INTEGRATIONS ?? "auto").trim().toLowerCase();
  if (raw === "auto" || raw === "live" || raw === "simulation") return raw;
  throw new Error(`HIVE_INTEGRATIONS must be auto|live|simulation, got: ${raw}`);
}

export function resolveIntegrations(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedIntegrations {
  const mode = modeSetting(env);
  const ledger = new EffectLedger();

  let github: GitHubGateway | null = null;
  let githubReason = "simulation (HIVE_GITHUB_REPO / HIVE_GITHUB_TOKEN not set)";
  let githubApiUrl: string | null = null;
  if (mode !== "simulation") {
    const gh = githubFromEnv(env); // throws on malformed repo
    if (gh) {
      github = new GitHubGateway(gh);
      githubApiUrl = gh.apiUrl;
      githubReason = `live: repo=${gh.repo} via ${env.HIVE_GITHUB_TOKEN ? "HIVE_GITHUB_TOKEN" : "gh auth token"} (${gh.apiUrl})`;
    } else if (mode === "live") {
      throw new Error(
        "HIVE_INTEGRATIONS=live but GitHub is not configured: set HIVE_GITHUB_REPO=owner/name and HIVE_GITHUB_TOKEN (or run `gh auth login`)",
      );
    }
  } else {
    githubReason = "simulation (HIVE_INTEGRATIONS=simulation)";
  }

  let slack: SlackGateway | null = null;
  let slackReason = "simulation (HIVE_SLACK_WEBHOOK_URL / HIVE_SLACK_BOT_TOKEN not set)";
  if (mode !== "simulation") {
    const cfg = slackFromEnv(env);
    if (cfg) {
      slack = new SlackGateway(cfg);
      slackReason =
        cfg.transport === "webhook"
          ? `live: incoming webhook → ${cfg.channel}`
          : `live: chat.postMessage → ${cfg.channel} (${cfg.apiUrl})`;
    } else if (mode === "live") {
      throw new Error(
        "HIVE_INTEGRATIONS=live but Slack is not configured: set HIVE_SLACK_WEBHOOK_URL or HIVE_SLACK_BOT_TOKEN + HIVE_SLACK_CHANNEL",
      );
    }
  } else {
    slackReason = "simulation (HIVE_INTEGRATIONS=simulation)";
  }

  return { mode, github, githubReason, githubApiUrl, slack, slackReason, ledgerPath: ledger.file };
}

export class LiveEffectConnectorHub extends EffectConnectorHub {
  private readonly resolved: ResolvedIntegrations;
  private readonly ledger: EffectLedger;

  constructor(resolved: ResolvedIntegrations, ledgerFile?: string) {
    super();
    this.resolved = resolved;
    this.ledger = new EffectLedger(ledgerFile);
  }

  override findExisting(
    tenantId: string,
    effect: EffectKind,
    args: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> | null {
    const { github, slack } = this.resolved;
    if (github && GitHubGateway.handles(effect)) {
      try {
        const hit = github.findExisting(effect, args, key);
        if (hit) return hit;
      } catch (err) {
        // Provider unreachable → fall back to local ledger before giving up.
        const ledgerHit = this.ledger.find(tenantId, key, effect);
        if (ledgerHit) return ledgerHit;
        throw err;
      }
      return null;
    }
    if (slack && effect === "post-slack") {
      return this.ledger.find(tenantId, key, effect);
    }
    return super.findExisting(tenantId, effect, args, key);
  }

  override perform(
    tenantId: string,
    effect: EffectKind,
    args: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const { github, slack } = this.resolved;
    let receipt: Record<string, unknown> | null = null;

    if (github && GitHubGateway.handles(effect)) {
      receipt = github.perform(effect, args, key);
    } else if (slack && effect === "post-slack") {
      receipt = slack.perform(effect, args, key);
    } else {
      return super.perform(tenantId, effect, args, key); // simulation path (DLP inside)
    }

    this.ledger.append({ tenantId, key, effect, receipt });
    return receipt;
  }
}

export function resolveEffectHub(
  env: NodeJS.ProcessEnv = process.env,
  ledgerFile?: string,
): LiveEffectConnectorHub {
  return new LiveEffectConnectorHub(resolveIntegrations(env), ledgerFile);
}

export interface IntegrationStatus {
  mode: IntegrationModeSetting;
  gatewayAuth: "bearer-required" | "open-dev";
  github: { mode: "live" | "simulation"; detail: string; apiUrl: string | null };
  slack: { mode: "live" | "simulation"; detail: string };
  ledgerPath: string;
  note: string;
}

export function integrationStatus(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  let resolved: ResolvedIntegrations;
  let error: string | null = null;
  let safeMode: IntegrationModeSetting = "auto";
  try {
    safeMode = modeSetting(env);
  } catch {
    safeMode = "auto";
  }
  try {
    resolved = resolveIntegrations(env);
  } catch (e) {
    // Report, don't crash the status endpoint — the server logs the same error at boot.
    error = e instanceof Error ? e.message : String(e);
    const ledger = new EffectLedger();
    resolved = {
      mode: safeMode,
      github: null,
      githubReason: `error: ${error}`,
      githubApiUrl: null,
      slack: null,
      slackReason: `error: ${error}`,
      ledgerPath: ledger.file,
    };
  }
  return {
    mode: resolved.mode,
    gatewayAuth: env.HIVE_GATEWAY_TOKEN ? "bearer-required" : "open-dev",
    github: {
      mode: resolved.github ? "live" : "simulation",
      detail: resolved.githubReason,
      apiUrl: resolved.githubApiUrl,
    },
    slack: {
      mode: resolved.slack ? "live" : "simulation",
      detail: resolved.slackReason,
    },
    ledgerPath: resolved.ledgerPath,
    note: error
      ? `Integration resolution failed: ${error}`
      : "Simulated categories are in-memory and reset on restart; live categories perform real API calls.",
  };
}
