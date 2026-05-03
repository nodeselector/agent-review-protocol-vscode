import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AdvanceCheckpointInput,
  BusService,
  ClaimNextInput,
  ClaimResult,
  CommandEnvelope,
  CommandRepository,
  CompleteCommandInput,
  EventEnvelope,
  EventRepository,
  FailCommandInput,
  ReadEventsAfterInput,
  RenewLeaseInput,
  SessionRecord,
  SessionRepository,
  SubscriptionCheckpoint,
  SubscriptionRepository,
  UpdateSessionInput,
  WorkspaceRecord,
  CreateSessionInput,
} from "@arp/domain";

export interface SqliteArpStoreOptions {
  dbPath: string;
}

export class SqliteArpStore implements CommandRepository, EventRepository, SubscriptionRepository, SessionRepository, BusService {
  readonly db: DatabaseSync;

  constructor(options: SqliteArpStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  async enqueue<TPayload>(command: CommandEnvelope<TPayload>): Promise<void> {
    this.db.prepare(
      `INSERT INTO commands (
        id, workspace_id, session_id, type, producer, created_at, available_at, status,
        lease_owner, lease_expires_at, attempt_count, idempotency_key, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      command.id,
      command.workspaceId,
      command.sessionId,
      command.type,
      command.producer,
      command.createdAt,
      command.availableAt,
      command.status,
      command.lease?.owner ?? null,
      command.lease?.expiresAt ?? null,
      command.attemptCount,
      command.idempotencyKey ?? null,
      JSON.stringify(command.payload),
    );
  }

  async getById<TPayload>(id: string): Promise<CommandEnvelope<TPayload> | null> {
    const row = this.db.prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as CommandRow | undefined;
    return row ? mapCommandRow<TPayload>(row) : null;
  }

  async claimNext<TPayload>(input: ClaimNextInput): Promise<ClaimResult<TPayload> | null> {
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const conditions = [
        `status = 'pending'`,
        `available_at <= ?`,
        `(lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ];
      const params: unknown[] = [input.now, input.now];

      if (input.workspaceId) {
        conditions.push(`workspace_id = ?`);
        params.push(input.workspaceId as string);
      }

      if (input.commandTypes && input.commandTypes.length > 0) {
        conditions.push(`type IN (${input.commandTypes.map(() => "?").join(", ")})`);
        params.push(...(input.commandTypes as string[]));
      }

      const row = this.db.prepare(
        `SELECT * FROM commands WHERE ${conditions.join(" AND ")} ORDER BY created_at LIMIT 1`
      ).get(...(params as any[])) as CommandRow | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db.prepare(
        `UPDATE commands
         SET status = 'claimed', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
         WHERE id = ?`
      ).run(input.workerId, leaseExpiresAt, row.id);

      this.db.exec("COMMIT");
      const claimed = await this.getById<TPayload>(row.id);
      if (!claimed) {
        return null;
      }

      return {
        command: claimed,
        claimedAt: input.now,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async renewLease(input: RenewLeaseInput): Promise<void> {
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString();
    const result = this.db.prepare(
      `UPDATE commands
       SET lease_expires_at = ?
       WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'processing')`
    ).run(leaseExpiresAt, input.commandId, input.workerId);

    if (result.changes === 0) {
      throw new Error("lease renewal failed");
    }
  }

  async complete(input: CompleteCommandInput): Promise<void> {
    const result = this.db.prepare(
      `UPDATE commands
       SET status = 'completed', lease_expires_at = NULL
       WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'processing')`
    ).run(input.commandId, input.workerId);

    if (result.changes === 0) {
      throw new Error("command completion failed");
    }
  }

  async fail(input: FailCommandInput): Promise<void> {
    const status = input.deadLetter ? "dead_letter" : input.retryAt ? "pending" : "failed";
    const availableAt = input.retryAt ?? input.failedAt;
    const result = this.db.prepare(
      `UPDATE commands
       SET status = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'processing')`
    ).run(status, availableAt, input.commandId, input.workerId);

    if (result.changes === 0) {
      throw new Error("command failure update failed");
    }
  }

  async requeueExpired(now: string): Promise<number> {
    const result = this.db.prepare(
      `UPDATE commands
       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
       WHERE status IN ('claimed', 'processing') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
    ).run(now);

    return Number(result.changes);
  }

  async append<TPayload>(event: EventEnvelope<TPayload>): Promise<EventEnvelope<TPayload>> {
    const result = this.db.prepare(
      `INSERT INTO events (
        id, workspace_id, session_id, type, producer, created_at, causation_id, correlation_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.workspaceId,
      event.sessionId,
      event.type,
      event.producer,
      event.createdAt,
      event.causationId ?? null,
      event.correlationId ?? null,
      JSON.stringify(event.payload),
    );

    return {
      ...event,
      seq: Number(result.lastInsertRowid),
    };
  }

  async appendMany<TPayload>(events: EventEnvelope<TPayload>[]): Promise<EventEnvelope<TPayload>[]> {
    const appended: EventEnvelope<TPayload>[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        appended.push(await this.append(event));
      }
      this.db.exec("COMMIT");
      return appended;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async readAfter<TPayload>(input: ReadEventsAfterInput): Promise<EventEnvelope<TPayload>[]> {
    const conditions = [`seq > ?`];
    const params: unknown[] = [input.afterSeq];

    if (input.workspaceId) {
      conditions.push(`workspace_id = ?`);
      params.push(input.workspaceId as string);
    }

    if (input.sessionId) {
      conditions.push(`session_id = ?`);
      params.push(input.sessionId as string);
    }

    if (input.eventTypes && input.eventTypes.length > 0) {
      conditions.push(`type IN (${input.eventTypes.map(() => "?").join(", ")})`);
      params.push(...(input.eventTypes as string[]));
    }

    params.push(input.limit);
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY seq ASC LIMIT ?`
    ).all(...(params as any[])) as EventRow[];

    return rows.map((row) => mapEventRow<TPayload>(row));
  }

  async getCheckpoint(consumerName: string): Promise<SubscriptionCheckpoint | null> {
    const row = this.db.prepare(`SELECT * FROM subscriptions WHERE consumer_name = ?`).get(consumerName) as SubscriptionRow | undefined;
    return row
      ? { consumerName: row.consumer_name, lastEventSeq: row.last_event_seq, updatedAt: row.updated_at }
      : null;
  }

  async advanceCheckpoint(input: AdvanceCheckpointInput): Promise<void> {
    this.db.prepare(
      `INSERT INTO subscriptions (id, consumer_name, last_event_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(consumer_name) DO UPDATE SET
         last_event_seq = CASE
           WHEN excluded.last_event_seq > subscriptions.last_event_seq THEN excluded.last_event_seq
           ELSE subscriptions.last_event_seq
         END,
         updated_at = excluded.updated_at`
    ).run(`sub_${input.consumerName}`, input.consumerName, input.nextEventSeq, input.updatedAt);
  }

  async ensureWorkspace(rootPath: string, now: string): Promise<WorkspaceRecord> {
    const existing = this.db.prepare(`SELECT * FROM workspaces WHERE root_path = ?`).get(rootPath) as WorkspaceRow | undefined;
    if (existing) {
      this.db.prepare(`UPDATE workspaces SET updated_at = ? WHERE id = ?`).run(now, existing.id);
      return { id: existing.id, rootPath: existing.root_path, createdAt: existing.created_at, updatedAt: now };
    }

    const id = `ws_${crypto.randomUUID()}`;
    this.db.prepare(`INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, rootPath, now, now);
    return { id, rootPath, createdAt: now, updatedAt: now };
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const id = `sess_${crypto.randomUUID()}`;
    this.db.prepare(
      `INSERT INTO sessions (id, workspace_id, status, created_at, updated_at, metadata_json)
       VALUES (?, ?, 'active', ?, ?, ?)`
    ).run(id, input.workspaceId, input.createdAt, input.createdAt, JSON.stringify(input.metadata ?? null));

    return {
      id,
      workspaceId: input.workspaceId,
      status: "active",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      metadata: input.metadata,
    };
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  }

  async updateSession(input: UpdateSessionInput): Promise<void> {
    const current = await this.getSession(input.sessionId);
    if (!current) {
      throw new Error("session not found");
    }

    this.db.prepare(
      `UPDATE sessions SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ?`
    ).run(
      input.status ?? current.status,
      input.updatedAt,
      JSON.stringify(input.metadata ?? current.metadata ?? null),
      input.sessionId,
    );
  }

  async enqueueCommand<TPayload>(command: CommandEnvelope<TPayload>): Promise<void> {
    await this.enqueue(command);
  }

  async claimCommand<TPayload>(input: ClaimNextInput): Promise<ClaimResult<TPayload> | null> {
    return await this.claimNext<TPayload>(input);
  }

  async completeCommand(input: CompleteCommandInput, emittedEvents: EventEnvelope[] = []): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      await this.complete(input);
      for (const event of emittedEvents) {
        await this.append(event);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async failCommand(input: FailCommandInput, emittedEvents: EventEnvelope[] = []): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      await this.fail(input);
      for (const event of emittedEvents) {
        await this.append(event);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async appendEvent<TPayload>(event: EventEnvelope<TPayload>): Promise<EventEnvelope<TPayload>> {
    return await this.append(event);
  }

  async readEventsAfter<TPayload>(input: ReadEventsAfterInput): Promise<EventEnvelope<TPayload>[]> {
    return await this.readAfter<TPayload>(input);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        producer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        available_at TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        producer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        consumer_name TEXT NOT NULL UNIQUE,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_commands_claim ON commands(status, available_at, lease_expires_at, workspace_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_read ON events(seq, workspace_id, session_id, type);
    `);
  }
}

type CommandRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  type: string;
  producer: string;
  created_at: string;
  available_at: string;
  status: CommandEnvelope["status"];
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  idempotency_key: string | null;
  payload_json: string;
};

type EventRow = {
  seq: number;
  id: string;
  workspace_id: string;
  session_id: string;
  type: string;
  producer: string;
  created_at: string;
  causation_id: string | null;
  correlation_id: string | null;
  payload_json: string;
};

type SubscriptionRow = {
  consumer_name: string;
  last_event_seq: number;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  root_path: string;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  workspace_id: string;
  status: SessionRecord["status"];
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
};

function mapCommandRow<TPayload>(row: CommandRow): CommandEnvelope<TPayload> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    type: row.type,
    producer: row.producer,
    createdAt: row.created_at,
    availableAt: row.available_at,
    status: row.status,
    lease: row.lease_owner && row.lease_expires_at ? { owner: row.lease_owner, expiresAt: row.lease_expires_at } : undefined,
    attemptCount: row.attempt_count,
    idempotencyKey: row.idempotency_key ?? undefined,
    payload: JSON.parse(row.payload_json) as TPayload,
  };
}

function mapEventRow<TPayload>(row: EventRow): EventEnvelope<TPayload> {
  return {
    id: row.id,
    seq: row.seq,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    type: row.type,
    producer: row.producer,
    createdAt: row.created_at,
    causationId: row.causation_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    payload: JSON.parse(row.payload_json) as TPayload,
  };
}

function mapSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
  };
}
