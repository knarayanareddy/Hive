/**
 * Append-only local ledger of performed live effects.
 *
 * GitHub exposes natural read-back for open-pr / merge / comment / branch, but
 * Slack's chat.postMessage has NO provider-side idempotency key. This ledger is
 * the second net (after the outbox's own status='confirmed' short-circuit) so a
 * crash between "provider returned 200" and "outbox row updated" does not cause
 * a duplicate post on retry. Entries are tenant-scoped; rows written before the
 * tenantId field existed are ignored on read.
 *
 * Honest limitation: a crash inside the perform call that already reached the
 * provider is still undetectable without provider support; the Slack message
 * text carries an `[hive:<idempotency-key>]` marker so operators can spot or
 * search for duplicates. For exactly-once Slack delivery, route through a
 * queue worker later.
 */
import fs from "node:fs";
import path from "node:path";

export interface LedgerEntry {
  tenantId: string;
  key: string;
  effect: string;
  receipt: Record<string, unknown>;
  at: string;
}

export class EffectLedger {
  public readonly file: string;

  constructor(file?: string) {
    this.file =
      file ??
      process.env.HIVE_EFFECT_LEDGER ??
      path.resolve(process.cwd(), ".hive/live-ledger.jsonl");
  }

  find(tenantId: string, key: string, effect: string): Record<string, unknown> | null {
    if (!fs.existsSync(this.file)) return null;
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as LedgerEntry;
        if (e.tenantId === tenantId && e.key === key && e.effect === effect) {
          return { ...e.receipt, reconciledViaReadBack: true, via: "ledger" };
        }
      } catch {
        /* skip corrupt line */
      }
    }
    return null;
  }

  append(entry: { tenantId: string; key: string; effect: string; receipt: Record<string, unknown> }): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const line: LedgerEntry = { ...entry, at: new Date().toISOString() };
    fs.appendFileSync(this.file, JSON.stringify(line) + "\n", "utf8");
  }
}
