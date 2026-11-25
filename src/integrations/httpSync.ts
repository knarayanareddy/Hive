/**
 * Synchronous minimal HTTP client for the authority kernel's effect path.
 *
 * The kernel is deliberately synchronous (node:sqlite DatabaseSync transactions).
 * Live external effects must therefore complete inside the outbox's perform call,
 * which is why this uses `curl` via execFileSync (argv-safe, no shell) instead of
 * async fetch. Trade-off: a slow provider blocks the event loop for up to
 * HIVE_EFFECT_HTTP_TIMEOUT_MS (default 10s). If you outgrow this, move effects to
 * a polling worker against the outbox table — the outbox schema already supports it.
 */
import { execFileSync } from "node:child_process";

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  text: string;
  json: unknown | null;
}

const MARKER = "\n__HIVE_HTTP_STATUS__";

export function httpSync(req: HttpRequest): HttpResponse {
  const timeoutSec = Math.max(1, Math.ceil((req.timeoutMs ?? 10_000) / 1000));
  const args = [
    "-sS",
    "-X",
    req.method,
    "--max-time",
    String(timeoutSec),
    "-w",
    `${MARKER}%{http_code}`,
    "-H",
    "User-Agent: hive-authority/0.1",
  ];
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (k.toLowerCase() === "user-agent") continue;
    args.push("-H", `${k}: ${v}`);
  }
  let bodyText: string | undefined;
  if (req.body !== undefined) {
    bodyText = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    args.push("-H", "Content-Type: application/json");
    args.push("--data-binary", "@-");
  }
  args.push(req.url);

  let out: string;
  try {
    out = execFileSync("curl", args, {
      encoding: "utf8",
      input: bodyText,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
    });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const detail = (err.stderr ? String(err.stderr) : err.message ?? "curl error").trim();
    throw new Error(`http ${req.method} ${req.url} failed: ${detail}`);
  }

  const idx = out.lastIndexOf(MARKER);
  const status = idx >= 0 ? Number(out.slice(idx + MARKER.length).trim()) : 0;
  const text = idx >= 0 ? out.slice(0, idx) : out;
  let json: unknown | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response body (e.g. Slack webhook "ok") */
  }
  return { status, text, json };
}
