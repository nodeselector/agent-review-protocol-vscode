import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSession, addDraftComment } from "../packages/vscode-extension/dist/vscode-extension/src/review-store.js";
import {
  enqueueDraftReviewToBus,
  getDefaultBusDbPath,
  getLatestRevisionFromBus,
} from "../packages/vscode-extension/dist/vscode-extension/src/bus-review.js";
import { SqliteArpStore } from "../packages/arp-store-sqlite/dist/index.js";
import { processNextReviewCommand } from "../packages/pi-adapter/dist/pi-adapter/src/bus-worker.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "arp-bus-review-"));
}

test("enqueueDraftReviewToBus persists review.submit command", async () => {
  const workspaceRoot = await makeWorkspace();
  const session = await ensureSession(workspaceRoot);
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/example.ts",
    side: "new",
    line: 7,
    body: "Prefer typed payloads over prompt-shaped strings.",
    category: "blocking",
  });

  const result = await enqueueDraftReviewToBus({
    workspaceRoot,
    session,
    review: {
      event: "comment",
      summary: "Draft review from VS Code",
      comments: [comment],
    },
    artifact: {
      id: "art_1",
      type: "gitDiff",
      patch: "diff --git a/src/example.ts b/src/example.ts",
      changedFiles: [{ path: "src/example.ts", status: "modified" }],
    },
  });

  assert.equal(result.dbPath, getDefaultBusDbPath(workspaceRoot));
  const store = new SqliteArpStore({ dbPath: result.dbPath });
  const command = await store.getById(result.commandId);
  const sessionRecord = await store.getSession(session.id);

  assert.equal(command?.type, "review.submit");
  assert.equal(command?.status, "pending");
  assert.equal(command?.sessionId, session.id);
  assert.equal(command?.payload.review.comments.length, 1);
  assert.equal(command?.payload.review.comments[0]?.id, comment.id);
  assert.equal(command?.payload.artifact.changedFiles[0]?.path, "src/example.ts");
  assert.equal(sessionRecord?.id, session.id);
});

test("getLatestRevisionFromBus returns the newest revision.proposed event for the session", async () => {
  const workspaceRoot = await makeWorkspace();
  const session = await ensureSession(workspaceRoot);
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/example.ts",
    side: "new",
    line: 11,
    body: "Keep the state structured.",
    category: "note",
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
      id: "art_2",
      type: "gitDiff",
      patch: "diff --git a/src/example.ts b/src/example.ts",
      changedFiles: [{ path: "src/example.ts", status: "modified" }],
    },
  });

  process.env.ARP_PI_ADAPTER_DISABLE_LIVE = "1";
  await processNextReviewCommand({ dbPath: enqueueResult.dbPath, workerId: "worker-test" });
  delete process.env.ARP_PI_ADAPTER_DISABLE_LIVE;

  const latest = await getLatestRevisionFromBus(workspaceRoot, session.id);
  assert.ok(latest);
  assert.equal(latest?.dbPath, enqueueResult.dbPath);
  assert.equal(latest?.sessionId, session.id);
  assert.equal(latest?.commandId, enqueueResult.commandId);
  assert.equal(latest?.result.mode, "stub");
  assert.equal(latest?.result.revision.sessionId, session.id);
});

 test("getLatestRevisionFromBus returns null when the session has no revision events", async () => {
  const workspaceRoot = await makeWorkspace();
  const session = await ensureSession(workspaceRoot);
  const latest = await getLatestRevisionFromBus(workspaceRoot, session.id);
  assert.equal(latest, null);
});
