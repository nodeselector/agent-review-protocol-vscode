import { spawn } from "node:child_process";

export function runJsonRpc(entrypoint, request, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`process exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const line = stdout.trim().split("\n").filter(Boolean).at(-1);
        if (!line) {
          reject(new Error(`no JSON-RPC response received: ${stderr}`));
          return;
        }

        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}
