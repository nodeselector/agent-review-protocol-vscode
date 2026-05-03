#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  nowIso,
  type AdapterReviewResult,
  type ReviewSubmitCommandPayload,
  type ReviewSubmitParams,
  type RevisionProposedEventPayload,
} from "../../protocol/src/index.js";
import { SqliteArpStore } from "@arp/store-sqlite";
import type { ClaimResult } from "@arp/domain";
import { submitReview } from "./review-submit.js";

export interface ProcessNextReviewCommandInput {
  dbPath: string;
  workerId?: string;
  now?: string;
  leaseDurationMs?: number;
}

export interface ProcessNextReviewCommandResult {
  kind: "idle" | "processed";
  commandId?: string;
  eventId?: string;
  sessionId?: string;
  mode?: AdapterReviewResult["mode"];
}

export async function processNextReviewCommand(
  input: ProcessNextReviewCommandInput,
): Promise<ProcessNextReviewCommandResult> {
  const store = new SqliteArpStore({ dbPath: input.dbPath });
  const now = input.now ?? nowIso();
  const workerId = input.workerId ?? `pi-bus-worker-${process.pid}`;

  await store.requeueExpired(now);
  const claimed = await store.claimCommand<ReviewSubmitCommandPayload>({
    workerId,
    now,
    leaseDurationMs: input.leaseDurationMs ?? 60_000,
    commandTypes: ["review.submit"],
  });

  if (!claimed) {
    return { kind: "idle" };
  }

  try {
    const params = toReviewSubmitParams(claimed);
    const result = await submitReview(params);
    const eventId = `evt_${randomUUID()}`;

    await store.completeCommand(
      {
        commandId: claimed.command.id,
        workerId,
        completedAt: nowIso(),
      },
      [
        {
          id: eventId,
          workspaceId: claimed.command.workspaceId,
          sessionId: claimed.command.sessionId,
          type: "revision.proposed",
          producer: "pi-bus-worker",
          createdAt: nowIso(),
          causationId: claimed.command.id,
          correlationId: claimed.command.sessionId,
          payload: {
            commandId: claimed.command.id,
            adapter: result.adapter,
            mode: result.mode,
            normalized: result.normalized,
            revision: result.revision,
            note: result.note,
            prompt: result.prompt,
            rawOutput: result.rawOutput,
          } satisfies RevisionProposedEventPayload,
        },
      ],
    );

    return {
      kind: "processed",
      commandId: claimed.command.id,
      eventId,
      sessionId: claimed.command.sessionId,
      mode: result.mode,
    };
  } catch (error) {
    await store.failCommand({
      commandId: claimed.command.id,
      workerId,
      failedAt: nowIso(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function toReviewSubmitParams(claimed: ClaimResult<ReviewSubmitCommandPayload>): ReviewSubmitParams {
  return {
    sessionId: claimed.command.sessionId,
    review: claimed.command.payload.review,
    artifact: claimed.command.payload.artifact,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbFlagIndex = args.indexOf("--db");
  const dbPath = dbFlagIndex >= 0 ? args[dbFlagIndex + 1] : process.env.ARP_BUS_DB_PATH;
  if (!dbPath) {
    throw new Error("Missing bus DB path. Pass --db <path> or set ARP_BUS_DB_PATH.");
  }

  const result = await processNextReviewCommand({ dbPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
