/**
 * src/server/streams.ts — SSE stream registry, per-principal caps, presence registry.
 * Pure logic (no node:http dependency) so it is unit-testable without a live server.
 *
 * Rules (Phase 2):
 *  - max 20 concurrent streams per principal (any kind)
 *  - agents: 1 live stream; a new agent stream replaces the old one (the old stream
 *    receives a `watch_replaced` frame and is closed)
 *  - presence: join on connect, heartbeat renews, leave → 60s grace before expiry
 */

export interface StreamRecord {
  id: string;
  tenantId: string;
  principalId: string;
  principalKind: "human" | "agent";
  channel: string | null;
  taskId: string | null;
  connectedAt: number;
  lastSeenAt: number;
  lastSeq: number; // seq cursor for replay suppression
  closed: boolean;
  close: (frame?: string) => void; // sends final frame (if any) and ends the response
  send?: (frame: string) => boolean; // live write; returns false when the socket is gone
}

export interface PresenceEntry {
  tenantId: string;
  principalId: string;
  principalKind: "human" | "agent";
  channels: string[];
  taskId: string | null;
  connectedAt: number;
  lastSeenAt: number;
  /** Set when the stream drops; entry expires PRESENCE_GRACE_MS after this. */
  disconnectedAt: number | null;
}

export const STREAM_LIMIT_PER_PRINCIPAL = 20;
export const AGENT_STREAM_LIMIT = 1;
export const PRESENCE_GRACE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

export function formatSseFrame(id: number | string | null, event: string | null, data: unknown): string {
  const lines: string[] = [];
  if (id !== null && id !== undefined) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  // SSE data must not contain raw newlines; JSON has none.
  lines.push(`data: ${JSON.stringify(data ?? null)}`);
  return lines.join("\n") + "\n\n";
}

export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/** Minimal incremental SSE parser shared by the SDK and tests (text → frames). */
export function parseSseBuffer(buffer: string): {
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
      if (line.startsWith(":")) continue; // comment/heartbeat
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0 || event) {
      frames.push({ id, event, data: dataLines.join("\n") });
    }
  }
  return { frames, rest };
}

export class SseHub {
  private readonly streams = new Set<StreamRecord>();

  /**
   * Register a stream. Returns the streams it replaced (agent watch_replaced, already closed
   * by this call with the final frame sent) or an error string when the cap is hit.
   */
  attach(rec: StreamRecord, now: number): { replaced: StreamRecord[]; error?: string } {
    const mine = [...this.streams].filter(
      (s) => !s.closed && s.tenantId === rec.tenantId && s.principalId === rec.principalId,
    );
    if (rec.principalKind === "agent" && mine.length >= AGENT_STREAM_LIMIT) {
      const replaced = mine.slice(0, mine.length - AGENT_STREAM_LIMIT + 1);
      for (const old of replaced) {
        this.closeWith(old, formatSseFrame(null, "watch_replaced", {
          reason: "agent_stream_replaced",
          principalId: rec.principalId,
          at: now,
        }));
      }
    }
    const live = [...this.streams].filter(
      (s) => !s.closed && s.tenantId === rec.tenantId && s.principalId === rec.principalId,
    );
    if (live.length >= STREAM_LIMIT_PER_PRINCIPAL) {
      return { replaced: [], error: `stream limit reached (${STREAM_LIMIT_PER_PRINCIPAL} per principal)` };
    }
    this.streams.add(rec);
    return { replaced: rec.principalKind === "agent" ? mine : [] };
  }

  detach(rec: StreamRecord): void {
    rec.closed = true;
    this.streams.delete(rec);
  }

  closeWith(rec: StreamRecord, finalFrame: string): void {
    if (rec.closed) return;
    rec.closed = true;
    try {
      rec.close(finalFrame);
    } catch {
      /* already gone */
    }
    this.streams.delete(rec);
  }

  /** Live (non-closed) streams for a tenant — used for fan-out and diagnostics. */
  liveIn(tenantId: string): StreamRecord[] {
    return [...this.streams].filter((s) => !s.closed && s.tenantId === tenantId);
  }

  /** Fan-out a frame to every live stream in a tenant; returns how many were written. */
  broadcast(tenantId: string, frame: string): number {
    let n = 0;
    for (const s of this.streams) {
      if (s.closed || s.tenantId !== tenantId) continue;
      if (!s.send) continue;
      try {
        if (s.send(frame)) n += 1;
        else this.detach(s);
      } catch {
        this.detach(s);
      }
    }
    return n;
  }

  count(tenantId: string, principalId: string): number {
    let n = 0;
    for (const s of this.streams) {
      if (!s.closed && s.tenantId === tenantId && s.principalId === principalId) n += 1;
    }
    return n;
  }
}

export class PresenceRegistry {
  private readonly entries = new Map<string, PresenceEntry>();

  private key(tenantId: string, principalId: string): string {
    return `${tenantId} ${principalId}`;
  }

  /** Connect or heartbeat-renew a presence entry. */
  touch(params: {
    tenantId: string;
    principalId: string;
    principalKind: "human" | "agent";
    channel: string | null;
    taskId: string | null;
    now: number;
  }): PresenceEntry {
    const key = this.key(params.tenantId, params.principalId);
    let e = this.entries.get(key);
    if (!e) {
      e = {
        tenantId: params.tenantId,
        principalId: params.principalId,
        principalKind: params.principalKind,
        channels: [],
        taskId: params.taskId,
        connectedAt: params.now,
        lastSeenAt: params.now,
        disconnectedAt: null,
      };
      this.entries.set(key, e);
    }
    e.principalKind = params.principalKind;
    e.lastSeenAt = params.now;
    e.disconnectedAt = null; // a heartbeat clears a pending drop (reconnect inside grace)
    if (params.channel && !e.channels.includes(params.channel)) e.channels.push(params.channel);
    if (params.taskId) e.taskId = params.taskId;
    return e;
  }

  /** Mark a principal disconnected (grace clock starts). */
  drop(tenantId: string, principalId: string, now: number): PresenceEntry | undefined {
    const e = this.entries.get(this.key(tenantId, principalId));
    if (e) {
      e.disconnectedAt = now;
      e.lastSeenAt = now;
    }
    return e;
  }

  /** Drop entries whose grace expired; returns the evicted entries (for presence fan-out). */
  sweep(now: number): PresenceEntry[] {
    const evicted: PresenceEntry[] = [];
    for (const [key, e] of this.entries) {
      if (e.disconnectedAt !== null && now - e.disconnectedAt > PRESENCE_GRACE_MS) {
        this.entries.delete(key);
        evicted.push(e);
      }
    }
    return evicted;
  }

  /** Live entries for a tenant, after sweeping expired ones. */
  snapshot(tenantId: string, now: number): PresenceEntry[] {
    this.sweep(now);
    return [...this.entries.values()].filter((e) => e.tenantId === tenantId);
  }
}
