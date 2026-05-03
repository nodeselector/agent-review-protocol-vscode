import { randomUUID } from "node:crypto";
import path from "node:path";
import { SqliteArpStore } from "@arp/store-sqlite";
import {
  nowIso,
  type Artifact,
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

export function getDefaultBusDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".arp", "bus", "arp.db");
}
