import { randomUUID } from "node:crypto";
import path from "node:path";
import { SqliteArpStore } from "@arp/store-sqlite";
import {
  nowIso,
  type AdapterReviewResult,
  type Artifact,
  type RevisionProposedEventPayload,
  type ReviewSubmitCommandPayload,
  type ReviewSubmitParams,
  type Session,
} from "../../protocol/src/index.js";

export interface EnqueueDraftReviewToBusInput {
  workspaceRoot: string;
  session: Session;
  artifact: Artifact;
  review: ReviewSubmitParams["review"];
  dbPath?: string;
}

export interface EnqueueDraftReviewToBusResult {
  dbPath: string;
  workspaceId: string;
  commandId: string;
  sessionId: string;
  enqueuedAt: string;
}

export interface LatestBusRevisionResult {
  dbPath: string;
  eventId: string;
  eventSeq: number;
  sessionId: string;
  commandId: string;
  result: AdapterReviewResult;
}

export interface WaitForRevisionFromBusInput {
  workspaceRoot: string;
  sessionId: string;
  commandId: string;
  dbPath?: string;
  consumerName?: string;
  afterSeq?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function enqueueDraftReviewToBus(
  input: EnqueueDraftReviewToBusInput,
): Promise<EnqueueDraftReviewToBusResult> {
  const dbPath = input.dbPath ?? getDefaultBusDbPath(input.workspaceRoot);
  const store = new SqliteArpStore({ dbPath });
  const now = nowIso();
  const workspace = await store.ensureWorkspace(input.workspaceRoot, now);
  const existingSession = await store.getSession(input.session.id);

  if (!existingSession) {
    await store.createSession({
      sessionId: input.session.id,
      workspaceId: workspace.id,
      createdAt: input.session.createdAt,
      metadata: {
        title: input.session.title,
        workspaceRoot: input.session.workspaceRoot,
        source: "vscode-extension",
      },
    });
  }

  const commandId = `cmd_${randomUUID()}`;
  await store.enqueueCommand<ReviewSubmitCommandPayload>({
    id: commandId,
    workspaceId: workspace.id,
    sessionId: input.session.id,
    type: "review.submit",
    producer: "vscode-extension",
    createdAt: now,
    availableAt: now,
    status: "pending",
    attemptCount: 0,
    payload: {
      artifact: input.artifact,
      review: input.review,
      submittedAt: now,
      workspaceRoot: input.workspaceRoot,
    },
  });

  return {
    dbPath,
    workspaceId: workspace.id,
    commandId,
    sessionId: input.session.id,
    enqueuedAt: now,
  };
}

export async function getLatestRevisionFromBus(
  workspaceRoot: string,
  sessionId: string,
  dbPath?: string,
): Promise<LatestBusRevisionResult | null> {
  const resolvedDbPath = dbPath ?? getDefaultBusDbPath(workspaceRoot);
  const store = new SqliteArpStore({ dbPath: resolvedDbPath });
  const events = await store.readEventsAfter<RevisionProposedEventPayload>({
    consumerName: `vscode-session-${sessionId}`,
    afterSeq: 0,
    limit: 100,
    sessionId,
    eventTypes: ["revision.proposed"],
  });

  const latest = events.at(-1);
  if (!latest) {
    return null;
  }

  return mapRevisionEvent(resolvedDbPath, latest);
}

export async function getCurrentBusEventSeq(workspaceRoot: string, dbPath?: string): Promise<number> {
  const resolvedDbPath = dbPath ?? getDefaultBusDbPath(workspaceRoot);
  const store = new SqliteArpStore({ dbPath: resolvedDbPath });
  const events = await store.readEventsAfter({
    consumerName: "vscode-high-water-mark",
    afterSeq: 0,
    limit: 10_000,
  });
  const latest = events.at(-1);
  return latest?.seq ?? 0;
}

export async function waitForRevisionFromBus(
  input: WaitForRevisionFromBusInput,
): Promise<LatestBusRevisionResult | null> {
  const resolvedDbPath = input.dbPath ?? getDefaultBusDbPath(input.workspaceRoot);
  const store = new SqliteArpStore({ dbPath: resolvedDbPath });
  const consumerName = input.consumerName ?? `vscode-session-${input.sessionId}`;
  const existingCheckpoint = await store.getCheckpoint(consumerName);
  let cursor = Math.max(input.afterSeq ?? 0, existingCheckpoint?.lastEventSeq ?? 0);
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const events = await store.readEventsAfter<RevisionProposedEventPayload>({
      consumerName,
      afterSeq: cursor,
      limit: 100,
      sessionId: input.sessionId,
      eventTypes: ["revision.proposed"],
    });

    for (const event of events) {
      cursor = Math.max(cursor, event.seq ?? cursor);
      if (event.payload.commandId === input.commandId) {
        await store.advanceCheckpoint({
          consumerName,
          nextEventSeq: cursor,
          updatedAt: nowIso(),
        });
        return mapRevisionEvent(resolvedDbPath, event);
      }
    }

    if (events.length > 0) {
      await store.advanceCheckpoint({
        consumerName,
        nextEventSeq: cursor,
        updatedAt: nowIso(),
      });
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

export function getDefaultBusDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".arp", "bus", "arp.db");
}

function mapRevisionEvent(
  dbPath: string,
  event: {
    id: string;
    seq?: number;
    sessionId: string;
    payload: RevisionProposedEventPayload;
  },
): LatestBusRevisionResult {
  return {
    dbPath,
    eventId: event.id,
    eventSeq: event.seq ?? 0,
    sessionId: event.sessionId,
    commandId: event.payload.commandId,
    result: {
      adapter: event.payload.adapter,
      mode: event.payload.mode,
      normalized: event.payload.normalized,
      revision: event.payload.revision,
      note: event.payload.note,
      prompt: event.payload.prompt,
      rawOutput: event.payload.rawOutput,
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
