#!/usr/bin/env node
import readline from "node:readline";
import {
  nowIso,
  type Capabilities,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type ReviewSubmitParams,
} from "../../protocol/src/index.js";
import { buildPrompt, createStubRevision, invokePiForReview, normalizeAssistantTextToRevision } from "./pi-client.js";

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

async function handle(request: JsonRpcRequest): Promise<void> {
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
            agent: {
              name: "pi",
              vendor: "choam",
            },
          },
        }),
      );
      return;
    case "review/submit": {
      const params = request.params as ReviewSubmitParams;

      if (process.env.ARP_PI_ADAPTER_DISABLE_LIVE === "1") {
        writeMessage(
          success(request.id, {
            adapter: "pi",
            mode: "stub",
            prompt: buildPrompt(params),
            normalized: true,
            revision: createStubRevision(params),
            note: "Live pi invocation disabled by ARP_PI_ADAPTER_DISABLE_LIVE=1.",
          }),
        );
        return;
      }

      try {
        const result = await invokePiForReview(params, process.cwd());
        writeMessage(
          success(request.id, {
            adapter: "pi",
            mode: "live",
            prompt: result.prompt,
            normalized: result.normalized,
            rawOutput: result.rawOutput,
            revision: result.revision,
          }),
        );
      } catch (invokeError) {
        writeMessage(
          success(request.id, {
            adapter: "pi",
            mode: "fallback",
            prompt: buildPrompt(params),
            normalized: false,
            revision: normalizeAssistantTextToRevision(
              invokeError instanceof Error ? invokeError.message : String(invokeError),
              params,
            ).revision,
            note: "Live pi invocation failed. Returned fallback revision payload.",
          }),
        );
      }
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

  void (async () => {
    try {
      const message = JSON.parse(line) as JsonRpcRequest;
      await handle(message);
    } catch (err) {
      writeMessage(error(null, err instanceof Error ? err.message : "Invalid JSON", -32700));
    }
  })();
});
