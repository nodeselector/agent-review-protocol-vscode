import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { submitReview } from "../packages/pi-adapter/dist/pi-adapter/src/review-submit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sampleDiffPath = path.join(repoRoot, "tests/fixtures/sample-review.diff");

async function makeParams(sessionId = "sess_pi") {
  const patch = await fs.readFile(sampleDiffPath, "utf8");
  return {
    sessionId,
    review: {
      event: "comment",
      summary: "Looks close",
      comments: [
        {
          id: "c_1",
          path: "src/fs.ts",
          side: "new",
          line: 84,
          body: "Preserve root slash semantics.",
          category: "blocking",
          status: "draft",
        },
      ],
    },
    artifact: {
      id: "art_1",
      type: "gitDiff",
      patch,
      changedFiles: [
        {
          path: "src/fs.ts",
          status: "modified",
        },
      ],
    },
  };
}

test("submitReview returns a stubbed result when live mode is disabled", async () => {
  const params = await makeParams();
  process.env.ARP_PI_ADAPTER_DISABLE_LIVE = "1";
  const result = await submitReview(params);
  delete process.env.ARP_PI_ADAPTER_DISABLE_LIVE;

  assert.equal(result.adapter, "pi");
  assert.equal(result.mode, "stub");
  assert.match(result.prompt ?? "", /Session: sess_pi/);
  assert.match(result.prompt ?? "", /Review event: comment/);
  assert.match(result.prompt ?? "", /diff --git a\/src\/fs.ts b\/src\/fs.ts/);
  assert.match(result.note ?? "", /Live pi invocation disabled/);
  assert.equal(result.normalized, true);
  assert.equal(result.revision.summary, "Stub mode enabled for testing.");
  assert.equal(result.revision.resolutions[0]?.status, "not_addressed");
});

test("submitReview returns fallback result when live invocation fails", async () => {
  const params = await makeParams("sess_fallback");
  const prevPath = process.env.PATH;
  const prevTimeout = process.env.ARP_PI_TIMEOUT_MS;
  process.env.PATH = "";
  process.env.ARP_PI_TIMEOUT_MS = "1000";

  const result = await submitReview(params);

  process.env.PATH = prevPath;
  if (prevTimeout === undefined) {
    delete process.env.ARP_PI_TIMEOUT_MS;
  } else {
    process.env.ARP_PI_TIMEOUT_MS = prevTimeout;
  }

  assert.equal(result.adapter, "pi");
  assert.equal(result.mode, "fallback");
  assert.equal(result.normalized, false);
  assert.match(result.note ?? "", /Live pi invocation failed/);
  assert.equal(result.revision.resolutions[0]?.status, "needs_clarification");
});
