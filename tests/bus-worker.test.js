import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSession, addDraftComment } from "../packages/vscode-extension/dist/vscode-extension/src/review-store.js";
import { enqueueDraftReviewToBus } from "../packages/vscode-extension/dist/vscode-extension/src/bus-review.js";
import { SqliteArpStore } from "../packages/arp-store-sqlite/dist/index.js";
import { processNextReviewCommand } from "../packages/pi-adapter/dist/pi-adapter/src/bus-worker.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "arp-bus-worker-"));
}

test("processNextReviewCommand claims review.submit and emits revision.proposed", async () => {
  const workspaceRoot = await makeWorkspace();
  const session = await ensureSession(workspaceRoot);
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/example.ts",
    side: "new",
    line: 9,
    body: "Preserve structure across the boundary.",
    category: "blocking",
  });

  const enqueueResult = await enqueueDraftReviewToBus({
    workspaceRoot,
    session,
    review: {
      event: "comment",
      summary: "Draft review from VS Code",
      comments: [comment],
    },
    artifact: {
      id: "art_worker_1",
      type: "gitDiff",
      patch: "diff --git a/src/example.ts b/src/example.ts",
      changedFiles: [{ path: "src/example.ts", status: "modified" }],
    },
  });

  process.env.ARP_PI_ADAPTER_DISABLE_LIVE = "1";
  const result = await processNextReviewCommand({ dbPath: enqueueResult.dbPath, workerId: "worker-test" });
  delete process.env.ARP_PI_ADAPTER_DISABLE_LIVE;

  assert.equal(result.kind, "processed");
  assert.equal(result.commandId, enqueueResult.commandId);
  assert.equal(result.mode, "stub");

  const store = new SqliteArpStore({ dbPath: enqueueResult.dbPath });
  const command = await store.getById(enqueueResult.commandId);
  const events = await store.readEventsAfter({ consumerName: "test", afterSeq: 0, limit: 10 });

  assert.equal(command?.status, "completed");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "revision.proposed");
  assert.equal(events[0]?.causationId, enqueueResult.commandId);
  assert.equal(events[0]?.payload.commandId, enqueueResult.commandId);
  assert.equal(events[0]?.payload.mode, "stub");
  assert.equal(events[0]?.payload.revision.sessionId, session.id);
});

test("processNextReviewCommand returns idle when no review.submit commands exist", async () => {
  const workspaceRoot = await makeWorkspace();
  const dbPath = path.join(workspaceRoot, ".arp", "bus", "arp.db");
  const result = await processNextReviewCommand({ dbPath, workerId: "worker-test" });
  assert.deepEqual(result, { kind: "idle" });
});
