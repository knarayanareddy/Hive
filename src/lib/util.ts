// Shared helpers for all prototypes. Everything here is mock/demo-grade.

/** cyrb53 – fast non-cryptographic hash. Used ONLY to fake ids/signatures in the demo. */
export function cyrb53(str: string, seed = 0) {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hex(s: string, n = 16) {
  let out = "";
  let i = 0;
  while (out.length < n) {
    out += cyrb53(s + ":" + i, i).toString(16).padStart(14, "0");
    i++;
  }
  return out.slice(0, n);
}

/** Simulated clock: minute 0 == 09:00 */
export function fmtClock(min: number) {
  const total = 9 * 60 + Math.floor(min);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** "10m" | "1h" | "90" -> minutes */
export function parseDur(s?: string | null): number | null {
  if (!s) return null;
  const m = /^(\d+)\s*(m|h|min|s)?$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (m[2] === "h") return n * 60;
  if (m[2] === "s") return Math.max(1, Math.round(n / 60));
  return n;
}

/** Shell-ish tokenizer that respects single and double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (const ch of line) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* ignore */
  }
}
