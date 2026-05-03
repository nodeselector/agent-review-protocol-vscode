import * as vscode from "vscode";
import { SqliteArpStore } from "@arp/store-sqlite";
import type { ReviewRequestedEventPayload, ReviewResponseEventPayload, Comment } from "../../protocol/src/index.js";
import { loadReviewStore, getActiveDraftComments } from "./review-store.js";

export interface ReviewRequest {
  requestId: string;
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  patch: string;
  changedFiles: Array<{ path: string; status: string }>;
  summary?: string;
  iteration: number;
  requestedAt: string;
  eventSeq: number;
}

export async function pollForReviewRequests(
  workspaceRoot: string,
  dbPath?: string,
): Promise<ReviewRequest | null> {
  const resolvedDbPath = dbPath ?? `${workspaceRoot}/.arp/bus/arp.db`;

  try {
    const store = new SqliteArpStore({ dbPath: resolvedDbPath });
    const events = await store.readEventsAfter<ReviewRequestedEventPayload>({
      consumerName: "vscode-reviewer",
      afterSeq: 0,
      limit: 100,
      eventTypes: ["review.requested"],
    });

    // Find the latest unresponded request
    const allEvents = await store.readEventsAfter<any>({
      consumerName: "vscode-reviewer-all",
      afterSeq: 0,
      limit: 1000,
    });

    const respondedRequestIds = new Set(
      allEvents
        .filter((e) => e.type === "review.response")
        .map((e) => {
          const payload = e.payload as ReviewResponseEventPayload;
          return payload.requestId;
        }),
    );

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const payload = event.payload as ReviewRequestedEventPayload;
      if (!respondedRequestIds.has(payload.requestId)) {
        return {
          requestId: payload.requestId,
          sessionId: payload.sessionId,
          workspaceId: event.workspaceId,
          workspaceRoot: payload.workspaceRoot,
          patch: payload.artifact.patch,
          changedFiles: payload.artifact.changedFiles as Array<{ path: string; status: string }>,
          summary: payload.summary,
          iteration: payload.iteration ?? 1,
          requestedAt: payload.requestedAt,
          eventSeq: event.seq ?? 0,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function submitReviewResponse(
  workspaceRoot: string,
  request: ReviewRequest,
  comments: Comment[],
  summary?: string,
  dbPath?: string,
): Promise<string> {
  const resolvedDbPath = dbPath ?? `${workspaceRoot}/.arp/bus/arp.db`;
  const store = new SqliteArpStore({ dbPath: resolvedDbPath });
  const { randomUUID } = await import("node:crypto");

  const eventId = `evt_${randomUUID()}`;
  const now = new Date().toISOString();

  await store.appendEvent({
    id: eventId,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    type: "review.response",
    producer: "vscode-reviewer",
    createdAt: now,
    causationId: request.requestId,
    correlationId: request.requestId,
    payload: {
      requestId: request.requestId,
      sessionId: request.sessionId,
      review: {
        event: "comment",
        summary: summary ?? "Review from VS Code",
        comments,
      },
      respondedAt: now,
    } satisfies ReviewResponseEventPayload,
  });

  return eventId;
}
