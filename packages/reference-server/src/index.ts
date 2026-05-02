#!/usr/bin/env node
import readline from "node:readline";
import {
  nowIso,
  type Capabilities,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type ReviewSubmitParams,
  type Revision,
} from "../../protocol/src/index.js";

const capabilities: Capabilities = {
  supports: {
    reviewSubmission: true,
    patchOutput: true,
    structuredResolutions: true,
    patchApply: false,
    streaming: false,
    diagnosticsContext: true,
    selectionContext: true,
  },
};

function success<T>(id: string | number, result: T): JsonRpcSuccess<T> {
  return { jsonrpc: "2.0", id, result };
}

function error(id: string | number | null, message: string, code = -32603): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function buildStubRevision(params: ReviewSubmitParams): Revision {
  return {
    id: `rev_${Date.now()}`,
    sessionId: params.sessionId,
    basedOnReviewId: `review_${Date.now()}`,
    summary: `Stub revision for ${params.review.comments.length} comment(s).`,
    patch: params.artifact.patch,
    resolutions: params.review.comments.map((comment: ReviewSubmitParams["review"]["comments"][number]) => ({
      commentId: comment.id,
      status: "needs_clarification",
      note: "Reference server does not revise code yet.",
    })),
    questions: [
      "Should review submission and revision request remain separate operations in v0?",
    ],
  };
}

function handle(request: JsonRpcRequest): void {
  switch (request.method) {
    case "capabilities/get":
      writeMessage(success(request.id, capabilities));
      return;
    case "session/create":
      writeMessage(
        success(request.id, {
          session: {
            id: `sess_${Date.now()}`,
            workspaceRoot: (request.params as { workspaceRoot?: string } | undefined)?.workspaceRoot ?? process.cwd(),
            createdAt: nowIso(),
          },
        }),
      );
      return;
    case "review/submit": {
      const params = request.params as ReviewSubmitParams;
      writeMessage(success(request.id, { revision: buildStubRevision(params) }));
      return;
    }
    default:
      writeMessage(error(request.id, `Method not implemented: ${request.method}`, -32601));
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line: string) => {
  if (!line.trim()) {
    return;
  }

  try {
    const message = JSON.parse(line) as JsonRpcRequest;
    handle(message);
  } catch (err) {
    writeMessage(error(null, err instanceof Error ? err.message : "Invalid JSON", -32700));
  }
});
