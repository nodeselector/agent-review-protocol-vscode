/**
 * ARP Review Extension for pi
 *
 * Polls the local ARP SQLite bus for review.submit commands,
 * injects the diff + comments as context for the LLM,
 * and writes revision.proposed events back to the bus.
 *
 * Usage:
 *   pi -e /path/to/arp-review-extension.ts
 *
 * Environment:
 *   ARP_BUS_DB_PATH - path to the SQLite bus database (required)
 *   ARP_POLL_INTERVAL_MS - poll interval in ms (default: 2000)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  let pendingReview: PendingReview | null = null;
  let busDbPath: string | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  interface PendingReview {
    commandId: string;
    sessionId: string;
    workspaceId: string;
    workspaceRoot: string;
    artifact: {
      patch: string;
      changedFiles: Array<{ path: string; status: string }>;
    };
    review: {
      event: string;
      summary?: string;
      comments: Array<{
        id: string;
        path: string;
        line?: number;
        startLine?: number;
        endLine?: number;
        body: string;
        category?: string;
        scope?: string;
      }>;
    };
  }

  // -- Bus helpers (inline to avoid import issues in pi's jiti loader) --

  function openDb(dbPath: string) {
    const { DatabaseSync } = require("node:sqlite");
    const { mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  }

  function claimNextReviewCommand(dbPath: string): PendingReview | null {
    const db = openDb(dbPath);
    try {
      const workerId = `pi-ext-${process.pid}`;
      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + 300_000).toISOString();

      // Requeue expired
      db.exec(`UPDATE commands SET status = 'pending', claimed_by = NULL, lease_until = NULL WHERE status = 'claimed' AND lease_until < '${now}'`);

      const row = db.prepare(
        `SELECT id, workspace_id, session_id, type, payload FROM commands WHERE status = 'pending' AND type = 'review.submit' ORDER BY created_at ASC LIMIT 1`
      ).get() as any;

      if (!row) return null;

      db.prepare(
        `UPDATE commands SET status = 'claimed', claimed_by = ?, lease_until = ?, claimed_at = ? WHERE id = ?`
      ).run(workerId, leaseUntil, now, row.id);

      const payload = JSON.parse(row.payload);
      return {
        commandId: row.id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        workspaceRoot: payload.workspaceRoot ?? ".",
        artifact: payload.artifact,
        review: payload.review,
      };
    } finally {
      db.close();
    }
  }

  function completeReviewCommand(
    dbPath: string,
    commandId: string,
    sessionId: string,
    workspaceId: string,
    result: any,
  ) {
    const db = openDb(dbPath);
    const { randomUUID } = require("node:crypto");
    try {
      const now = new Date().toISOString();
      const workerId = `pi-ext-${process.pid}`;
      const eventId = `evt_${randomUUID()}`;

      db.prepare(
        `UPDATE commands SET status = 'completed', completed_at = ? WHERE id = ?`
      ).run(now, commandId);

      db.prepare(
        `INSERT INTO events (id, workspace_id, session_id, type, producer, created_at, causation_id, correlation_id, payload)
         VALUES (?, ?, ?, 'revision.proposed', ?, ?, ?, ?, ?)`
      ).run(
        eventId,
        workspaceId,
        sessionId,
        workerId,
        now,
        commandId,
        sessionId,
        JSON.stringify({
          commandId,
          adapter: "pi-extension",
          mode: "live",
          normalized: true,
          revision: result.revision,
          note: result.note,
        }),
      );

      return eventId;
    } finally {
      db.close();
    }
  }

  function failReviewCommand(dbPath: string, commandId: string, errorMessage: string) {
    const db = openDb(dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE commands SET status = 'failed', failed_at = ?, error_message = ? WHERE id = ?`
      ).run(now, errorMessage, commandId);
    } finally {
      db.close();
    }
  }

  // -- Polling --

  function startPolling() {
    if (pollTimer || !busDbPath) return;
    const interval = parseInt(process.env.ARP_POLL_INTERVAL_MS ?? "2000", 10);

    pollTimer = setInterval(() => {
      if (pendingReview) return; // already processing one
      try {
        const review = claimNextReviewCommand(busDbPath!);
        if (review) {
          pendingReview = review;
          pi.sendUserMessage(buildReviewPrompt(review), { deliverAs: "followUp" });
        }
      } catch (err) {
        // silently retry next interval
      }
    }, interval);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  // -- Prompt building --

  function buildReviewPrompt(review: PendingReview): string {
    const comments = review.review.comments
      .map((c) => {
        const loc = c.line ?? `${c.startLine}-${c.endLine}`;
        const scope = c.scope ?? "review";
        return `- [${c.id}] ${c.path}:${loc} (${scope}/${c.category ?? "note"}) ${c.body}`;
      })
      .join("\n");

    return [
      "You have received an ARP code review to address.",
      "",
      `Changed files: ${review.artifact.changedFiles.map((f) => f.path).join(", ")}`,
      "",
      "Review comments:",
      comments || "- none",
      "",
      "Diff:",
      "```diff",
      review.artifact.patch,
      "```",
      "",
      "Read the relevant files to understand the full context, then use the arp_review_respond tool to submit your response.",
      "For each comment, provide a resolution with status and explanation.",
      "If a comment asks you to change code, explain what you would change and why.",
    ].join("\n");
  }

  // -- Tool for structured response --

  pi.registerTool({
    name: "arp_review_respond",
    label: "ARP Review Respond",
    description:
      "Submit a structured response to an ARP code review. Call this after reading the code and considering all review comments.",
    promptSnippet: "Submit structured ARP review response with resolutions for each comment",
    promptGuidelines: [
      "Use arp_review_respond to submit your response to an ARP code review.",
      "Before calling arp_review_respond, read the relevant source files to understand the full context.",
      "Include one resolution for every review comment -- do not skip any.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Brief summary of your review response" }),
      resolutions: Type.Array(
        Type.Object({
          commentId: Type.String({ description: "The comment ID from the review" }),
          status: Type.Union(
            [
              Type.Literal("addressed"),
              Type.Literal("partially_addressed"),
              Type.Literal("not_addressed"),
              Type.Literal("needs_clarification"),
            ],
            { description: "Resolution status" },
          ),
          note: Type.String({ description: "Explanation of how the comment was addressed or why not" }),
        }),
        { description: "One resolution per review comment" },
      ),
      questions: Type.Optional(
        Type.Array(Type.String(), { description: "Questions back to the reviewer, if any" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!pendingReview || !busDbPath) {
        return {
          content: [{ type: "text" as const, text: "No active ARP review to respond to." }],
          details: {},
        };
      }

      const review = pendingReview;
      pendingReview = null;

      const revision = {
        id: `rev_${Date.now()}`,
        sessionId: review.sessionId,
        basedOnReviewId: `review_${review.commandId}`,
        summary: params.summary,
        patch: review.artifact.patch,
        resolutions: params.resolutions,
        questions: params.questions,
      };

      try {
        const eventId = completeReviewCommand(busDbPath, review.commandId, {
          revision,
          note: `Reviewed by pi extension`,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `ARP review response submitted.\n- Command: ${review.commandId}\n- Event: ${eventId}\n- Resolutions: ${params.resolutions.length}`,
            },
          ],
          details: { revision, eventId },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failReviewCommand(busDbPath, review.commandId, msg);
        return {
          content: [{ type: "text" as const, text: `Failed to submit ARP review: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // -- Lifecycle --

  pi.on("session_start", async (_event, ctx) => {
    busDbPath = process.env.ARP_BUS_DB_PATH;
    if (!busDbPath) {
      ctx.ui.notify("ARP: no ARP_BUS_DB_PATH set, review polling disabled", "info");
      return;
    }
    ctx.ui.notify(`ARP: polling ${busDbPath}`, "info");
    startPolling();
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    pendingReview = null;
  });
}
