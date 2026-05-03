import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSession, addDraftComment } from "../packages/vscode-extension/dist/vscode-extension/src/review-store.js";
import { enqueueDraftReviewToBus } from "../packages/vscode-extension/dist/vscode-extension/src/bus-review.js";
import { SqliteArpStore } from "../packages/arp-store-sqlite/dist/index.js";
import { runReviewWorkerLoop } from "../packages/pi-adapter/dist/pi-adapter/src/bus-worker-loop.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "arp-bus-worker-loop-"));
}

test("runReviewWorkerLoop processes queued commands until idle limit", async () => {
  const workspaceRoot = await makeWorkspace();
  const session = await ensureSession(workspaceRoot);
  const first = await addDraftComment(workspaceRoot, {
    path: "src/example.ts",
    side: "new",
    line: 21,
    body: "First queued review",
    category: "note",
  });
  const second = await addDraftComment(workspaceRoot, {
    path: "src/example.ts",
    side: "new",
    line: 22,
    body: "Second queued review",
    category: "blocking",
  });

  const one = await enqueueDraftReviewToBus({
    workspaceRoot,
    session,
    review: { event: "comment", summary: "one", comments: [first] },
    artifact: {
      id: "art_loop_1",
      type: "gitDiff",
      patch: "diff --git a/src/example.ts b/src/example.ts",
      changedFiles: [{ path: "src/example.ts", status: "modified" }],
    },
  });

  await enqueueDraftReviewToBus({
    workspaceRoot,
    session,
    review: { event: "comment", summary: "two", comments: [second] },
    artifact: {
      id: "art_loop_2",
      type: "gitDiff",
      patch: "diff --git a/src/example.ts b/src/example.ts",
      changedFiles: [{ path: "src/example.ts", status: "modified" }],
    },
    dbPath: one.dbPath,
  });

  process.env.ARP_PI_ADAPTER_DISABLE_LIVE = "1";
  const seen = [];
  const result = await runReviewWorkerLoop({
    dbPath: one.dbPath,
    workerId: "loop-test",
    pollIntervalMs: 5,
    maxIdleIterations: 2,
    onIteration: (iterationResult) => {
      seen.push(iterationResult.kind);
    },
  });
  delete process.env.ARP_PI_ADAPTER_DISABLE_LIVE;

  assert.equal(result.stopReason, "max-idle-iterations");
  assert.equal(result.processedCount, 2);
  assert.ok(result.iterations >= 4);
  assert.deepEqual(seen.slice(0, 4), ["processed", "processed", "idle", "idle"]);

  const store = new SqliteArpStore({ dbPath: one.dbPath });
  const events = await store.readEventsAfter({ consumerName: "loop-test", afterSeq: 0, limit: 10 });
  assert.equal(events.filter((event) => event.type === "revision.proposed").length, 2);
});

test("runReviewWorkerLoop stops on abort signal", async () => {
  const workspaceRoot = await makeWorkspace();
  const dbPath = path.join(workspaceRoot, ".arp", "bus", "arp.db");
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 20);
  const result = await runReviewWorkerLoop({
    dbPath,
    workerId: "loop-abort-test",
    pollIntervalMs: 50,
    signal: controller.signal,
  });

  assert.equal(result.stopReason, "signal");
  assert.ok(result.iterations <= 1);
});

test("runReviewWorkerLoop honors maxIterations", async () => {
  const workspaceRoot = await makeWorkspace();
  const dbPath = path.join(workspaceRoot, ".arp", "bus", "arp.db");
  const result = await runReviewWorkerLoop({
    dbPath,
    workerId: "loop-iteration-test",
    pollIntervalMs: 1,
    maxIterations: 3,
  });

  assert.equal(result.stopReason, "max-iterations");
  assert.equal(result.iterations, 3);
  assert.equal(result.processedCount, 0);
});
