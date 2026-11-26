/**
 * Hive SDK — typed client for the Hive Authority Kernel gateway.
 *
 *   import { HiveClient } from "hive/sdk";
 *   const hive = new HiveClient({ baseUrl: "http://127.0.0.1:8787", token: process.env.HIVE_HST });
 *   const state = await hive.getState("acme");
 *   for await (const frame of hive.events({ tenant: "acme", channel: "dev" })) {
 *     if (frame.type === "event") console.log(frame.event.kind);
 *   }
 *
 * Auth: pass an `hst_` session token (user/service) or use the CLI bearer from
 * `HIVE_GATEWAY_TOKEN` (coarse edge only, no principal identity).
 *
 * Leases: `withLeaseHeartbeat({ taskId, ttlMs, token })` renews an `hct_` capability
 * on an interval derived from the lease TTL. Renewal rotates the token; the fresh
 * token is readable via the callback argument so long-lived workers never sign with
 * a stale epoch. (Heartbeats are hook-driven, never prompt-driven.)
 *
 * SSE: `events()` consumes `GET /api/events` with `Authorization` (fetch streams —
 * not EventSource, which cannot set headers). Reconnects resume from `lastEventId`
 * (`Last-Event-ID` semantics). The server fences streams per principal
 * (20/principal; agents: 1 live stream, replaced streams receive `watch_replaced`).
 */

export interface HiveClientOptions {
  /** Gateway origin. Defaults to same-origin (single-origin deployments). */
  baseUrl?: string;
  /** hst_ session token (or gateway bearer for the coarse edge). */
  token: string;
  /** Test seam: inject a fetch implementation. */
  fetchImpl?: typeof fetch;
}

export interface HiveEvent {
  seq: number;
  id: string;
  prev: string;
  kind: string;
  actor: string;
  channel: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
  trust: "owner" | "member" | "external";
  attest: string[];
  sig: string;
  createdAt: number;
}

export type HiveStreamFrame =
  | { type: "event"; event: HiveEvent }
  | { type: "ready"; tenant: string; principalId: string; incarnation: string; streams: number; replayed: number }
  | { type: "presence"; tenant: string; watchers: Array<Record<string, unknown>> }
  | { type: "watch_replaced"; reason: string; principalId: string; at: number }
  | { type: "error"; error: string; retryAfterSeconds?: number };

export class HiveHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HiveHttpError";
    this.status = status;
  }
}

export interface CliResult {
  ok: boolean;
  status: number;
  lines: string[];
  state?: Record<string, unknown>;
  tokenJar?: Record<string, string>;
  data?: unknown;
}

export interface StreamOptions {
  tenant?: string;
  channel?: string;
  taskId?: string;
  /** Resume cursor: only events with seq > lastEventId are sent (Last-Event-ID). */
  lastEventId?: number;
  signal?: AbortSignal;
}

/* Inline copy of the SSE frame parser (kept dependency-free for the published build). */
function parseSseBuffer(buffer: string): {
  frames: { id: string | null; event: string | null; data: string }[];
  rest: string;
} {
  const frames: { id: string | null; event: string | null; data: string }[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let id: string | null = null;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0 || event) frames.push({ id, event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

export class HiveClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HiveClientOptions) {
    if (!options.token) throw new Error("HiveClient requires a token (hst_ session or gateway bearer)");
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.body ? { "Content-Type": init.body instanceof Uint8Array ? "application/octet-stream" : "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body (artifact fetch handles bytes itself) */
    }
    if (!res.ok) {
      const message =
        (parsed as { error?: string } | undefined)?.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
      throw new HiveHttpError(res.status, message);
    }
    return parsed as T;
  }

  /** Full workspace snapshot (same payload {@link /api/state} returns). */
  getState(tenant?: string): Promise<Record<string, unknown>> {
    const q = tenant ? `?tenant=${encodeURIComponent(tenant)}` : "";
    return this.request(`/api/state${q}`);
  }

  /** Run a CLI line through the real kernel (same semantics as `hive …`). */
  cli(line: string, opts?: { tenant?: string }): Promise<CliResult> {
    return this.request(`/api/cli`, {
      method: "POST",
      body: JSON.stringify({ line, tenant: opts?.tenant }),
    });
  }

  /** Current session identity. */
  me(): Promise<{ ok: boolean; tenant: string; principalId: string; via: string }> {
    return this.request(`/api/session/me`);
  }

  /** Presence roster for a tenant (who is watching, within the 60s grace window). */
  presence(tenant?: string): Promise<{ ok: boolean; watchers: Array<Record<string, unknown>> }> {
    const q = tenant ? `?tenant=${encodeURIComponent(tenant)}` : "";
    return this.request(`/api/presence${q}`);
  }

  /** Upload an evidence artifact (content-addressed, ≤25 MiB by default). */
  async artifactPut(
    bytes: Uint8Array,
    mediaType = "application/octet-stream",
    evidenceId?: string,
  ): Promise<{ sha256: string; size: number; url: string }> {
    const q = evidenceId ? `?evidenceId=${encodeURIComponent(evidenceId)}` : "";
    const res = await this.fetchImpl(this.url(`/api/artifacts${q}`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": mediaType },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
    const body = (await res.json()) as { ok: boolean; sha256?: string; size?: number; url?: string; error?: string };
    if (!res.ok || !body.ok || !body.sha256 || !body.url) {
      throw new HiveHttpError(res.status, body.error ?? `artifact upload failed (HTTP ${res.status})`);
    }
    return { sha256: body.sha256, size: body.size ?? bytes.length, url: body.url };
  }

  /** Download an artifact (bytes + media type). */
  async artifactGet(sha256: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const res = await this.fetchImpl(this.url(`/api/artifacts/${encodeURIComponent(sha256)}`), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new HiveHttpError(res.status, `artifact fetch failed (HTTP ${res.status})`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mediaType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Consume the SSE stream (`GET /api/events`) as an async generator.
   * Reconnect by calling again with `lastEventId` = last seq you saw.
   * Stops on abort (AbortSignal) or stream end.
   */
  async *events(opts: StreamOptions = {}): AsyncGenerator<HiveStreamFrame> {
    const params = new URLSearchParams();
    if (opts.tenant) params.set("tenant", opts.tenant);
    if (opts.channel) params.set("channel", opts.channel);
    if (opts.taskId) params.set("taskId", opts.taskId);
    if (opts.lastEventId && opts.lastEventId > 0) params.set("lastEventId", String(opts.lastEventId));
    const res = await this.fetchImpl(this.url(`/api/events?${params}`), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "text/event-stream",
        ...(opts.lastEventId ? { "Last-Event-ID": String(opts.lastEventId) } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new HiveHttpError(res.status, text.slice(0, 200) || `events stream failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
        try {
          const data = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {};
          switch (frame.event) {
            case "event":
              yield { type: "event", event: data as unknown as HiveEvent };
              break;
            case "ready":
              yield {
                type: "ready",
                tenant: String(data.tenant ?? ""),
                principalId: String(data.principalId ?? ""),
                incarnation: String(data.incarnation ?? ""),
                streams: Number(data.streams ?? 0),
                replayed: Number(data.replayed ?? 0),
              };
              break;
            case "presence":
              yield { type: "presence", tenant: String(data.tenant ?? ""), watchers: (data.watchers as Array<Record<string, unknown>>) ?? [] };
              break;
            case "watch_replaced":
              yield { type: "watch_replaced", ...(data as { reason: string; principalId: string; at: number }) };
              return; // server closes this stream after this frame
            case "error":
              yield { type: "error", ...(data as { error: string; retryAfterSeconds?: number }) };
              return;
            default:
              break; // unknown future frame kinds are ignored, not fatal
          }
        } catch {
          // Malformed frame: skip rather than kill the stream.
        }
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) return; // caller aborted — end cleanly
      throw err;
    }
  }

  /**
   * Run `fn` while heartbeating the task lease every ttl/3.
   * `fn` receives the *current* capability token (renewal rotates it).
   */
  async withLeaseHeartbeat<T>(
    args: { taskId: string; ttlMs: number; token: string; tenant?: string; renewIntervalMs?: number },
    fn: (ctx: { token: () => string; cli: (line: string) => Promise<CliResult> }) => Promise<T>,
  ): Promise<T> {
    let current = args.token;
    const every = Math.max(args.renewIntervalMs ?? Math.floor(args.ttlMs / 3), 5_000);
    const tenant = args.tenant;
    const renew = async () => {
      const out = await this.cli(`hive task renew ${args.taskId} --token ${current}`, { tenant });
      const jar = out.tokenJar ?? {};
      const fresh = Object.entries(jar).find(([k]) => k.endsWith(`:${args.taskId}`))?.[1];
      if (out.ok && fresh) current = fresh;
      return out;
    };
    void renew().catch(() => undefined); // renew immediately; failures retried on the interval
    const timer = setInterval(() => {
      void renew().catch(() => undefined);
    }, every);
    timer.unref?.();
    try {
      return await fn({ token: () => current, cli: (line: string) => this.cli(line, { tenant }) });
    } finally {
      clearInterval(timer);
    }
  }
}
