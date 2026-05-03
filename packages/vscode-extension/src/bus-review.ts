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

  return {
    dbPath: resolvedDbPath,
    eventId: latest.id,
    eventSeq: latest.seq ?? 0,
    sessionId: latest.sessionId,
    commandId: latest.payload.commandId,
    result: {
      adapter: latest.payload.adapter,
      mode: latest.payload.mode,
      normalized: latest.payload.normalized,
      revision: latest.payload.revision,
      note: latest.payload.note,
      prompt: latest.payload.prompt,
      rawOutput: latest.payload.rawOutput,
    },
  };
}

export function getDefaultBusDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".arp", "bus", "arp.db");
}
