export type Trust = "owner" | "member" | "external";

export type TaskState =
  // 7 observable states. The former 5 transient states (expired, submitted,
  // merged, rejected, reopened) were written and rewritten within a single
  // transaction and therefore never persisted; see docs/migrations/001.
  | "blocked"
  | "ready"
  | "claimed"
  | "halted"
  | "verifying"
  | "awaiting_approval"
  | "closed";

export type GatePolicy = "none" | "one" | "two_of_three";

export type EffectKind = "open-pr" | "merge" | "post-slack" | "post-github" | "open-branch";

export interface Attestation {
  owner: string;
  scope: string[]; // e.g. ['chat.post', 'task.claim', 'task.submit', 'patch.push', 'effect.open-pr']
  notAfter: number;
  revoked: boolean;
  sig: string;
}

export interface Principal {
  id: string;
  tenantId: string;
  kind: "human" | "agent";
  pubkey: string;
  owner?: string;
  harness?: string;
  role: string; // 'owner' | 'lead' | 'security' | 'member' | 'worker' | 'verifier' | 'reviewer'
  attestation?: Attestation;
}

export interface CapabilityClaims {
  sub: string;
  tenant: string;
  incarnation: string;
  task?: string;
  epoch?: number;
  ops: string[];
  budgetCents?: number;
  notAfter: number;
  chain: string[];
}

export interface InboundMessage {
  source: "slack" | "github" | "linear" | "cli" | "ui";
  principal: string;
  trust: Trust;
  channel: string;
  text: string;
  externalRef?: string;
  flags: {
    instructionLike: boolean;
    secretLike: boolean;
    matchedSpans: string[];
  };
  renderedForAgent: string;
}

export interface TaskRecord {
  id: string;
  tenantId: string;
  goalId: string | null;
  channel: string;
  branchRoom: string | null;
  title: string;
  state: TaskState;
  owner: string | null;
  leaseEpoch: number;
  leaseUntil: number | null;
  attempt: number;
  budgetCapCents: number;
  budgetSpent: number;
  revision: number;
  originOperationId: string;
  trust: Trust;
  headSha: string | null;
  protectedPath: string | null;
  gatePolicy: GatePolicy;
  verifiedClose: string | null;
  labels: Record<string, string>;
  deps: string[];
  createdAt: number;
  updatedAt: number;
}

export interface EventRecord {
  seq: number;
  tenantId: string;
  id: string;
  prev: string;
  kind: string;
  actor: string;
  channel: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
  trust: Trust;
  attest: string[];
  sig: string;
  createdAt: number;
}

export interface CheckpointRecord {
  id: string;
  tenantId: string;
  uptoSeq: number;
  headEventId: string;
  merkleRoot: string;
  incarnation: string;
  sig: string;
  createdAt: number;
}

export interface EvidenceRecord {
  id: string;
  tenantId: string;
  taskId: string;
  kind: string;
  headSha: string;
  leaseEpoch: number;
  result: Record<string, unknown>;
  passed: boolean;
  producedBy: string;
  sandboxTree: string;
  receiptHash: string;
  createdAt: number;
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  taskId: string;
  headSha: string;
  approver: string;
  role: string;
  decision: "approve" | "reject";
  comment: string | null;
  sig: string;
  invalidatedAt: number | null;
  invalidatedReason: string | null;
  createdAt: number;
}

export interface OutboxRecord {
  idempotencyKey: string;
  tenantId: string;
  taskId: string | null;
  leaseEpoch: number | null;
  effect: EffectKind;
  args: Record<string, unknown>;
  status: "pending" | "sent" | "confirmed" | "failed";
  receipt: Record<string, unknown> | null;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WakeRecord {
  id: number;
  tenantId: string;
  principal: string;
  taskId: string | null;
  channel: string | null;
  reason: string;
  noSync: boolean;
  dueAt: number;
  deliveredAt: number | null;
  deliveryAttempts: number;
  ackAt: number | null;
}

export interface GrantRecord {
  id: string;
  tenantId: string;
  principal: string;
  path: string;
  can: string[];
  createdBy: string;
  createdAt: number;
}

export interface SchemaRecord {
  name: string;
  tenantId: string;
  description: string;
  required: string[];
  enums: Record<string, string[]>;
}

export interface ChannelRoom {
  name: string;
  tenantId: string;
  kind: "channel" | "branch";
  repo: string | null;
  branch: string | null;
  origin: string;
  createdBy: string;
  createdAt: number;
}

export interface WorkingSetDelivery {
  wakeId: number;
  principal: string;
  taskId: string | null;
  reason: string;
  cursorFrom: number;
  cursorTo: number;
  totalEventsInLog: number;
  diffEvents: EventRecord[];
  compressionRatioPct: number;
  token?: string;
}

export interface LogVerifyResult {
  ok: boolean;
  checkedEvents: number;
  checkpointVerified: boolean;
  checkpointId?: string;
  badSeq?: number;
  badEventId?: string;
  reason?: string;
}

export class HiveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HiveError";
    this.status = status;
    this.code = code;
  }
}

export class ConflictError extends HiveError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

export class FencedError extends HiveError {
  constructor(message: string) {
    super(409, "FENCED", message);
  }
}

export class IncarnationMismatchError extends HiveError {
  constructor(message: string) {
    super(409, "INCARNATION_MISMATCH", message);
  }
}

export class ForbiddenError extends HiveError {
  constructor(message: string) {
    super(403, "FORBIDDEN", message);
  }
}

export class HaltedError extends HiveError {
  constructor(message: string) {
    super(423, "HALTED", message);
  }
}

export class ValidationError extends HiveError {
  constructor(message: string) {
    super(422, "UNPROCESSABLE", message);
  }
}

export class ArtifactCorruptError extends HiveError {
  constructor(message: string) {
    super(500, "ARTIFACT_CORRUPT", message);
  }
}
