import { z } from "zod";
import { tokenize } from "../lib/util";
import { ValidationError } from "./types";

export const SlashTriageSchema = z.object({
  verb: z.literal("triage"),
  taskId: z.string().min(1),
  severity: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  area: z.string().default("general"),
  assignHint: z.string().optional(),
});

export const SlashApproveSchema = z.object({
  verb: z.literal("approve"),
  taskId: z.string().min(1),
  sha: z.string().min(4).optional(),
  comment: z.string().optional(),
});

export const SlashRejectSchema = z.object({
  verb: z.literal("reject"),
  taskId: z.string().min(1),
  comment: z.string().min(1, "rejection requires --comment"),
});

export const SlashResumeSchema = z.object({
  verb: z.literal("resume"),
  taskId: z.string().min(1),
  capDollars: z.number().positive(),
  hint: z.string().optional(),
});

export const SlashShipSchema = z.object({
  verb: z.literal("ship"),
  taskId: z.string().min(1),
  sha: z.string().min(4).optional(),
});

export type ParsedSlashCommand =
  | z.infer<typeof SlashTriageSchema>
  | z.infer<typeof SlashApproveSchema>
  | z.infer<typeof SlashRejectSchema>
  | z.infer<typeof SlashResumeSchema>
  | z.infer<typeof SlashShipSchema>;

export const REGISTERED_SLASH_COMMANDS = [
  {
    slash: "/triage <id> [--severity P1] [--area checkout]",
    who: "human | agent",
    desc: "Classify task metadata and unblock/queue eligible workers.",
  },
  {
    slash: "/approve <id> [--sha <head>]",
    who: "human only",
    desc: "Record a signed SHA-bound human approval receipt on a gated task.",
  },
  {
    slash: "/reject <id> --comment \"...\"",
    who: "human only",
    desc: "Reject current submission, keep merge blocked, reopen task with feedback wake.",
  },
  {
    slash: "/resume <id> --cap <dollars> [--hint \"...\"]",
    who: "human only",
    desc: "Reset circuit breaker on a halted task with a raised budget cap.",
  },
  {
    slash: "/ship <id> [--sha <head>]",
    who: "human | authorized workflow",
    desc: "Execute gated idempotent merge via outbox and finalize VerifiedClose.",
  },
] as const;

export function parseSlashCommand(line: string): ParsedSlashCommand {
  const toks = tokenize(line.trim());
  if (!toks.length || !toks[0].startsWith("/")) {
    throw new ValidationError("not a registered /command");
  }
  const verb = toks[0].slice(1).toLowerCase();
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.startsWith("--")) {
      flags[tk.slice(2)] = toks[++i] ?? "";
    } else {
      pos.push(tk.replace(/^#/, ""));
    }
  }

  try {
    switch (verb) {
      case "triage":
        return SlashTriageSchema.parse({
          verb: "triage",
          taskId: pos[0] ?? "",
          severity: flags.severity ?? "P2",
          area: flags.area ?? "checkout",
          assignHint: flags.owner ?? flags.assign,
        });
      case "approve":
        return SlashApproveSchema.parse({
          verb: "approve",
          taskId: pos[0] ?? "",
          sha: flags.sha || undefined,
          comment: flags.comment || undefined,
        });
      case "reject":
        return SlashRejectSchema.parse({
          verb: "reject",
          taskId: pos[0] ?? "",
          comment: flags.comment ?? (pos.slice(1).join(" ") || "changes requested"),
        });
      case "resume":
        return SlashResumeSchema.parse({
          verb: "resume",
          taskId: pos[0] ?? "",
          capDollars: Number(flags.cap ?? pos[1] ?? NaN),
          hint: flags.hint || undefined,
        });
      case "ship":
        return SlashShipSchema.parse({
          verb: "ship",
          taskId: pos[0] ?? "",
          sha: flags.sha || undefined,
        });
      default:
        throw new ValidationError(
          `unregistered command "/${verb}" — registered verbs: /triage, /approve, /reject, /resume, /ship`,
        );
    }
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    if (e instanceof z.ZodError) {
      throw new ValidationError(
        `invalid /${verb} arguments: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    throw e;
  }
}
