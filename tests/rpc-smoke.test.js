import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function runJsonRpc(entrypoint, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd: repoRoot,
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

test("reference server returns capabilities", async () => {
  const response = await runJsonRpc(path.join(repoRoot, "dist/reference-server/src/index.js"), {
    jsonrpc: "2.0",
    id: 1,
    method: "capabilities/get",
  });

  assert.equal(response.id, 1);
  assert.ok(response.result);
  assert.deepEqual(response.error, undefined);

  const supports = response.result.supports;
  assert.equal(supports.reviewSubmission, true);
  assert.equal(supports.patchOutput, true);
  assert.equal(supports.structuredResolutions, true);
});

test("reference server returns stub revision for review submit", async () => {
  const response = await runJsonRpc(path.join(repoRoot, "dist/reference-server/src/index.js"), {
    jsonrpc: "2.0",
    id: 2,
    method: "review/submit",
    params: {
      sessionId: "sess_test",
      review: {
        event: "request_changes",
        summary: "Need a fix",
        comments: [
          {
            id: "c_1",
            path: "src/main.ts",
            side: "new",
            line: 42,
            body: "Handle empty input",
            category: "blocking",
            status: "draft",
          },
        ],
      },
      artifact: {
        id: "art_1",
        type: "gitDiff",
        patch: "diff --git a/src/main.ts b/src/main.ts\n",
        changedFiles: [
          {
            path: "src/main.ts",
            status: "modified",
          },
        ],
      },
    },
  });

  assert.equal(response.id, 2);
  assert.ok(response.result);
  assert.deepEqual(response.error, undefined);

  const revision = response.result.revision;
  assert.equal(revision.sessionId, "sess_test");
  assert.equal(revision.patch, "diff --git a/src/main.ts b/src/main.ts\n");
  assert.equal(revision.resolutions.length, 1);
  assert.equal(revision.resolutions[0]?.commentId, "c_1");
  assert.equal(revision.resolutions[0]?.status, "needs_clarification");
});

test("pi adapter returns a prompt-shaped stub response", async () => {
  const response = await runJsonRpc(path.join(repoRoot, "dist/pi-adapter/src/index.js"), {
    jsonrpc: "2.0",
    id: 3,
    method: "review/submit",
    params: {
      sessionId: "sess_pi",
      review: {
        event: "comment",
        summary: "Looks close",
        comments: [
          {
            id: "c_9",
            path: "src/fs.ts",
            side: "new",
            startLine: 10,
            endLine: 12,
            body: "Extract this branch",
            category: "note",
            status: "draft",
          },
        ],
      },
      artifact: {
        id: "art_9",
        type: "gitDiff",
        patch: "diff --git a/src/fs.ts b/src/fs.ts\n",
        changedFiles: [
          {
            path: "src/fs.ts",
            status: "modified",
          },
        ],
      },
    },
  });

  assert.equal(response.id, 3);
  assert.ok(response.result);
  assert.deepEqual(response.error, undefined);

  const result = response.result;
  assert.equal(result.adapter, "pi");
  assert.match(result.prompt, /Session: sess_pi/);
  assert.match(result.prompt, /Review event: comment/);
  assert.match(result.prompt, /src\/fs.ts:10-12: Extract this branch/);
  assert.match(result.prompt, /diff --git a\/src\/fs.ts b\/src\/fs.ts/);
  assert.match(result.note, /Stub only/);
});
