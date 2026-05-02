import { spawn } from "node:child_process";
import { type JsonRpcRequest } from "../../protocol/src/index.js";

export type SpawnLike = typeof spawn;

export interface JsonRpcClientOptions {
  spawnImpl?: SpawnLike;
  timeoutMs?: number;
}

export function sendJsonRpc(command: string, request: JsonRpcRequest, options: JsonRpcClientOptions = {}): Promise<unknown> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 30000;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill?.();
      reject(new Error(`timed out waiting for ${command} after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(stderr || `process exited with code ${code}`));
        return;
      }

      try {
        const response = stdout.trim();
        if (!response) {
          reject(new Error("invalid JSON-RPC response"));
          return;
        }

        resolve(JSON.parse(response));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("invalid JSON-RPC response"));
      }
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}
