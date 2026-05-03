/**
 * ARP Review Extension for pi
 *
 * Gives the coding agent a `request_review` tool.
 * When called, it:
 *   1. Captures the current git diff
 *   2. Writes a `review.requested` event to the ARP bus
 *   3. Blocks waiting for a `review.response` event from the human reviewer (VS Code)
 *   4. Returns the human's review comments to the agent
 *
 * The agent can then act on the feedback.
 *
 * Environment:
 *   ARP_BUS_DB_PATH - path to the SQLite bus database (required)
 *   ARP_REVIEW_POLL_MS - poll interval while waiting for review (default: 2000)
 *   ARP_REVIEW_TIMEOUT_MS - max wait time for review (default: 600000 = 10min)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  let busDbPath: string | undefined;

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

  function ensureSchema(dbPath: string) {
    const db = openDb(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          seq INTEGER UNIQUE,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          producer TEXT NOT NULL,
          created_at TEXT NOT NULL,
          causation_id TEXT,
          correlation_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS commands (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          producer TEXT NOT NULL,
          created_at TEXT NOT NULL,
          available_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          claimed_by TEXT,
          claimed_at TEXT,
          lease_until TEXT,
          completed_at TEXT,
          failed_at TEXT,
          error_message TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          idempotency_key TEXT,
          payload TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          root_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS subscription_checkpoints (
          consumer_name TEXT PRIMARY KEY,
          last_event_seq INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }
  }

  function ensureWorkspaceAndSession(dbPath: string, workspaceRoot: string, sessionId: string) {
    const db = openDb(dbPath);
    const { randomUUID } = require("node:crypto");
    try {
      const now = new Date().toISOString();
      const workspaceId = `ws_${randomUUID()}`;

      const existingWs = db.prepare("SELECT id FROM workspaces WHERE root_path = ?").get(workspaceRoot) as any;
      const wsId = existingWs?.id ?? workspaceId;
      if (!existingWs) {
        db.prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)").run(wsId, workspaceRoot, now, now);
      }

      const existingSession = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as any;
      if (!existingSession) {
        db.prepare("INSERT INTO sessions (id, workspace_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(sessionId, wsId, now, now);
      }

      return wsId;
    } finally {
      db.close();
    }
  }

  function writeReviewRequestedEvent(
    dbPath: string,
    workspaceId: string,
    sessionId: string,
    requestId: string,
    workspaceRoot: string,
    patch: string,
    changedFiles: Array<{ path: string; status: string }>,
    summary?: string,
  ) {
    const db = openDb(dbPath);
    const { randomUUID } = require("node:crypto");
    try {
      const now = new Date().toISOString();
      const eventId = `evt_${randomUUID()}`;

      db.prepare(
        `INSERT INTO events (id, workspace_id, session_id, type, producer, created_at, causation_id, correlation_id, payload)
         VALUES (?, ?, ?, 'review.requested', 'pi-extension', ?, ?, ?, ?)`
      ).run(
        eventId,
        workspaceId,
        sessionId,
        now,
        requestId,
        sessionId,
        JSON.stringify({
          requestId,
          sessionId,
          workspaceRoot,
          artifact: { id: `art_${randomUUID()}`, type: "gitDiff", patch, changedFiles },
          summary,
          requestedAt: now,
        }),
      );

      return eventId;
    } finally {
      db.close();
    }
  }

  function pollForReviewResponse(
    dbPath: string,
    sessionId: string,
    requestId: string,
    signal: AbortSignal | undefined,
    pollMs: number,
    timeoutMs: number,
  ): Promise<any | null> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        if (signal?.aborted) {
          resolve(null);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          resolve(null);
          return;
        }

        try {
          const db = openDb(dbPath);
          try {
            const row = db.prepare(
              `SELECT payload FROM events
               WHERE session_id = ? AND type = 'review.response' AND correlation_id = ?
               ORDER BY seq DESC LIMIT 1`
            ).get(sessionId, requestId) as any;

            if (row) {
              resolve(JSON.parse(row.payload));
              return;
            }
          } finally {
            db.close();
          }
        } catch (err) {
          // retry
        }

        setTimeout(check, pollMs);
      };

      check();
    });
  }

  // -- Tool --

  pi.registerTool({
    name: "request_review",
    label: "Request Review",
    description:
      "Request a human code review of the current changes. Captures the git diff and sends it to the reviewer. Blocks until the reviewer responds with comments. Use this when you want feedback on your changes before continuing.",
    promptSnippet: "Request human code review of current git changes, blocks until reviewer responds",
    promptGuidelines: [
      "Use request_review when you have made changes and want human feedback before proceeding.",
      "request_review captures the current git diff automatically -- do not pass the diff yourself.",
      "request_review blocks until the human reviewer responds, which may take minutes.",
      "After receiving review feedback, read and address each comment before continuing.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({ description: "Brief description of what you changed and what you want reviewed" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!busDbPath) {
        return {
          content: [{ type: "text" as const, text: "ARP bus not configured. Set ARP_BUS_DB_PATH." }],
          details: {},
          isError: true,
        };
      }

      // Capture git diff
      onUpdate?.({ content: [{ type: "text" as const, text: "Capturing git diff..." }] });

      let patch: string;
      let changedFiles: Array<{ path: string; status: string }>;
      try {
        const diffResult = await pi.exec("git", ["diff", "HEAD"], { signal });
        patch = diffResult.stdout;
        if (!patch.trim()) {
          return {
            content: [{ type: "text" as const, text: "No changes to review. git diff HEAD is empty." }],
            details: {},
          };
        }

        const nameStatusResult = await pi.exec("git", ["diff", "HEAD", "--name-status"], { signal });
        changedFiles = nameStatusResult.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [status, ...pathParts] = line.split("\t");
            const filePath = pathParts.join("\t");
            const statusMap: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed" };
            return { path: filePath, status: statusMap[status?.[0] ?? "M"] ?? "modified" };
          });
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture git diff: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }

      // Write review request to bus
      const { randomUUID } = require("node:crypto");
      const requestId = `req_${randomUUID()}`;
      const sessionId = `pi_${process.pid}_${Date.now()}`;
      const workspaceRoot = ctx.cwd;

      ensureSchema(busDbPath);
      const workspaceId = ensureWorkspaceAndSession(busDbPath, workspaceRoot, sessionId);

      writeReviewRequestedEvent(
        busDbPath,
        workspaceId,
        sessionId,
        requestId,
        workspaceRoot,
        patch,
        changedFiles,
        params.summary,
      );

      onUpdate?.({
        content: [{ type: "text" as const, text: `Review requested (${requestId}). Waiting for reviewer...\n${changedFiles.length} changed files.` }],
      });

      // Block waiting for response
      const pollMs = parseInt(process.env.ARP_REVIEW_POLL_MS ?? "2000", 10);
      const timeoutMs = parseInt(process.env.ARP_REVIEW_TIMEOUT_MS ?? "600000", 10);

      const response = await pollForReviewResponse(busDbPath, sessionId, requestId, signal, pollMs, timeoutMs);

      if (!response) {
        return {
          content: [{ type: "text" as const, text: `Review timed out after ${timeoutMs / 1000}s. No response received for ${requestId}.` }],
          details: { requestId, timedOut: true },
        };
      }

      // Format the review feedback for the agent
      const comments = response.review?.comments ?? [];
      if (comments.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Review completed with no comments. ${response.review?.summary ?? "Approved."}` }],
          details: { requestId, response },
        };
      }

      const commentLines = comments.map((c: any) => {
        const loc = c.line ?? `${c.startLine}-${c.endLine}`;
        const scope = c.scope ?? "review";
        const cat = c.category ?? "note";
        return `- [${cat}] ${c.path}:${loc} (${scope}): ${c.body}`;
      });

      const feedbackText = [
        `## Review Feedback`,
        "",
        response.review?.summary ? `Summary: ${response.review.summary}` : null,
        "",
        `${comments.length} comment${comments.length === 1 ? "" : "s"}:`,
        "",
        ...commentLines,
      ]
        .filter((line) => line !== null)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: feedbackText }],
        details: { requestId, response },
      };
    },
  });

  // -- Slash command --

  pi.registerCommand("review", {
    description: "Request a human code review of current changes",
    handler: async (args, ctx) => {
      const summary = args.trim() || undefined;
      pi.sendUserMessage(
        summary
          ? `Use request_review to get human feedback on the current changes. Summary: ${summary}`
          : "Use request_review to get human feedback on the current changes.",
      );
    },
  });

  // -- Lifecycle --

  pi.on("session_start", async (_event, ctx) => {
    busDbPath = process.env.ARP_BUS_DB_PATH;
    if (!busDbPath) {
      const path = require("node:path");
      busDbPath = path.join(ctx.cwd, ".arp", "bus", "arp.db");
    }
    ensureSchema(busDbPath);
    ctx.ui.notify(`ARP: review tool ready -- bus at ${busDbPath}`, "info");
  });

  pi.on("session_shutdown", async () => {
    busDbPath = undefined;
  });
}
