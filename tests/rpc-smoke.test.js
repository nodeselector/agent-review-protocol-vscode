import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runJsonRpc } from "./helpers/json-rpc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sampleDiffPath = path.join(repoRoot, "tests/fixtures/sample-review.diff");

test("reference server returns capabilities", async () => {
  const response = await runJsonRpc(
    path.join(repoRoot, "packages/reference-server/dist/reference-server/src/index.js"),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "capabilities/get",
    },
    repoRoot,
  );

  assert.equal(response.id, 1);
  assert.ok(response.result);
  assert.deepEqual(response.error, undefined);

  const supports = response.result.supports;
  assert.equal(supports.reviewSubmission, true);
  assert.equal(supports.patchOutput, true);
  assert.equal(supports.structuredResolutions, true);
});

test("reference server returns stub revision for review submit", async () => {
  const sampleDiff = await fs.readFile(sampleDiffPath, "utf8");
  const response = await runJsonRpc(
    path.join(repoRoot, "packages/reference-server/dist/reference-server/src/index.js"),
    {
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
              path: "src/fs.ts",
              side: "new",
              line: 84,
              body: "Handle root path preservation",
              category: "blocking",
              status: "draft",
            },
          ],
        },
        artifact: {
          id: "art_1",
          type: "gitDiff",
          patch: sampleDiff,
          changedFiles: [
            {
              path: "src/fs.ts",
              status: "modified",
            },
          ],
        },
      },
    },
    repoRoot,
  );

  assert.equal(response.id, 2);
  assert.ok(response.result);
  assert.deepEqual(response.error, undefined);

  const revision = response.result.revision;
  assert.equal(revision.sessionId, "sess_test");
  assert.equal(revision.patch, sampleDiff);
  assert.equal(revision.resolutions.length, 1);
  assert.equal(revision.resolutions[0]?.commentId, "c_1");
  assert.equal(revision.resolutions[0]?.status, "needs_clarification");
});

