export type CommandStatus = "pending" | "claimed" | "processing" | "completed" | "failed" | "dead_letter";

export interface WorkspaceRecord {
  id: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  workspaceId: string;
  status: "active" | "closed" | "stale";
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface Lease {
  owner: string;
  expiresAt: string;
}

export interface CommandEnvelope<TPayload = unknown> {
  id: string;
  workspaceId: string;
  sessionId: string;
  type: string;
  producer: string;
  createdAt: string;
  availableAt: string;
  status: CommandStatus;
  lease?: Lease;
  attemptCount: number;
  idempotencyKey?: string;
  payload: TPayload;
}

export interface EventEnvelope<TPayload = unknown> {
  id: string;
  seq?: number;
  workspaceId: string;
  sessionId: string;
  type: string;
  producer: string;
  createdAt: string;
  causationId?: string;
  correlationId?: string;
  payload: TPayload;
}

export interface SubscriptionCheckpoint {
  consumerName: string;
  lastEventSeq: number;
  updatedAt: string;
}

export interface ClaimNextInput {
  workerId: string;
  now: string;
  leaseDurationMs: number;
  commandTypes?: string[];
  workspaceId?: string;
}

export interface ClaimResult<TPayload = unknown> {
  command: CommandEnvelope<TPayload>;
  claimedAt: string;
}

export interface RenewLeaseInput {
  commandId: string;
  workerId: string;
  now: string;
  leaseDurationMs: number;
}

export interface CompleteCommandInput {
  commandId: string;
  workerId: string;
  completedAt: string;
}

export interface FailCommandInput {
  commandId: string;
  workerId: string;
  failedAt: string;
  errorMessage: string;
  retryAt?: string;
  deadLetter?: boolean;
}

export interface ReadEventsAfterInput {
  consumerName: string;
  afterSeq: number;
  limit: number;
  workspaceId?: string;
  sessionId?: string;
  eventTypes?: string[];
}

export interface AdvanceCheckpointInput {
  consumerName: string;
  nextEventSeq: number;
  updatedAt: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface UpdateSessionInput {
  sessionId: string;
  status?: SessionRecord["status"];
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface CommandRepository {
  enqueue<TPayload>(command: CommandEnvelope<TPayload>): Promise<void>;
  getById<TPayload>(id: string): Promise<CommandEnvelope<TPayload> | null>;
  claimNext<TPayload>(input: ClaimNextInput): Promise<ClaimResult<TPayload> | null>;
  renewLease(input: RenewLeaseInput): Promise<void>;
  complete(input: CompleteCommandInput): Promise<void>;
  fail(input: FailCommandInput): Promise<void>;
  requeueExpired(now: string): Promise<number>;
}

export interface EventRepository {
  append<TPayload>(event: EventEnvelope<TPayload>): Promise<EventEnvelope<TPayload>>;
  appendMany<TPayload>(events: EventEnvelope<TPayload>[]): Promise<EventEnvelope<TPayload>[]>;
  readAfter<TPayload>(input: ReadEventsAfterInput): Promise<EventEnvelope<TPayload>[]>;
}

export interface SubscriptionRepository {
  getCheckpoint(consumerName: string): Promise<SubscriptionCheckpoint | null>;
  advanceCheckpoint(input: AdvanceCheckpointInput): Promise<void>;
}

export interface SessionRepository {
  ensureWorkspace(rootPath: string, now: string): Promise<WorkspaceRecord>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(input: UpdateSessionInput): Promise<void>;
}

export interface BusService {
  enqueueCommand<TPayload>(command: CommandEnvelope<TPayload>): Promise<void>;
  claimCommand<TPayload>(input: ClaimNextInput): Promise<ClaimResult<TPayload> | null>;
  renewLease(input: RenewLeaseInput): Promise<void>;
  completeCommand(input: CompleteCommandInput, emittedEvents?: EventEnvelope[]): Promise<void>;
  failCommand(input: FailCommandInput, emittedEvents?: EventEnvelope[]): Promise<void>;
  appendEvent<TPayload>(event: EventEnvelope<TPayload>): Promise<EventEnvelope<TPayload>>;
  readEventsAfter<TPayload>(input: ReadEventsAfterInput): Promise<EventEnvelope<TPayload>[]>;
  advanceCheckpoint(input: AdvanceCheckpointInput): Promise<void>;
}

export const ARP_INVARIANTS = [
  "Command IDs are globally unique.",
  "Event IDs are globally unique.",
  "A command belongs to exactly one workspace and one session.",
  "Only pending commands whose availability time has passed and whose lease is absent or expired are claimable.",
  "Claiming a command is atomic: choose command, assign lease, increment attempts.",
  "At most one active lease may exist for a command at a time.",
  "Only the active lease owner may renew, complete, or fail a claimed command in the normal path.",
  "Completing a command and appending resulting events must be one atomic unit.",
  "Failing a command and appending resulting events must be one atomic unit.",
  "Events are append-only and immutable once written.",
  "Subscription checkpoints only move forward.",
  "Durability is for delivery and recovery, not permanent archival.",
] as const;

export const SQLITE_ADAPTER_BOUNDARY = {
  requiredAtomicOperations: [
    "enqueue command",
    "claim next command",
    "complete command with emitted events",
    "fail command with emitted events",
    "advance subscription checkpoint",
  ],
  requiredCapabilities: [
    "short write transactions",
    "lease expiry checks",
    "monotonic event sequencing",
    "busy timeout / contention handling",
    "bounded retention cleanup",
  ],
} as const;
