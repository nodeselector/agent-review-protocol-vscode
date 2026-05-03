import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteArpStore } from "../packages/arp-store-sqlite/dist/index.js";

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arp-sqlite-"));
  const dbPath = path.join(dir, "arp.db");
  return new SqliteArpStore({ dbPath });
}

test("sqlite store can create workspace and session", async () => {
  const store = await makeStore();
  const now = new Date().toISOString();
  const workspace = await store.ensureWorkspace("/tmp/repo-a", now);
  const session = await store.createSession({ workspaceId: workspace.id, createdAt: now, metadata: { source: "test" } });

  assert.match(workspace.id, /^ws_/);
  assert.match(session.id, /^sess_/);
  assert.equal(session.workspaceId, workspace.id);
  assert.equal(session.status, "active");
});

test("sqlite store can enqueue and claim a command", async () => {
  const store = await makeStore();
  const now = new Date().toISOString();
  const workspace = await store.ensureWorkspace("/tmp/repo-b", now);
  const session = await store.createSession({ workspaceId: workspace.id, createdAt: now });

  await store.enqueueCommand({
    id: "cmd_1",
    workspaceId: workspace.id,
    sessionId: session.id,
    type: "review.submit",
    producer: "vscode",
    createdAt: now,
    availableAt: now,
    status: "pending",
    attemptCount: 0,
    payload: { hello: true },
  });

  const claimed = await store.claimCommand({
    workerId: "worker-1",
    now,
    leaseDurationMs: 60_000,
    commandTypes: ["review.submit"],
  });

  assert.ok(claimed);
  assert.equal(claimed.command.id, "cmd_1");
  assert.equal(claimed.command.status, "claimed");
  assert.equal(claimed.command.lease?.owner, "worker-1");
  assert.equal(claimed.command.attemptCount, 1);
});

test("completeCommand atomically appends emitted events", async () => {
  const store = await makeStore();
  const now = new Date().toISOString();
  const workspace = await store.ensureWorkspace("/tmp/repo-c", now);
  const session = await store.createSession({ workspaceId: workspace.id, createdAt: now });

  await store.enqueueCommand({
    id: "cmd_2",
    workspaceId: workspace.id,
    sessionId: session.id,
    type: "review.submit",
    producer: "vscode",
    createdAt: now,
    availableAt: now,
    status: "pending",
    attemptCount: 0,
    payload: { hi: true },
  });

  const claimed = await store.claimCommand({
    workerId: "worker-2",
    now,
    leaseDurationMs: 60_000,
  });

  await store.completeCommand(
    {
      commandId: claimed.command.id,
      workerId: "worker-2",
      completedAt: now,
    },
    [
      {
        id: "evt_1",
        workspaceId: workspace.id,
        sessionId: session.id,
        type: "revision.proposed",
        producer: "pi-worker",
        createdAt: now,
        causationId: claimed.command.id,
        correlationId: session.id,
        payload: { revisionId: "rev_1" },
      },
    ],
  );

  const command = await store.getById("cmd_2");
  const events = await store.readEventsAfter({ consumerName: "test", afterSeq: 0, limit: 10 });

  assert.equal(command?.status, "completed");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "revision.proposed");
  assert.equal(events[0]?.seq, 1);
});

test("subscription checkpoints only move forward", async () => {
  const store = await makeStore();
  const now = new Date().toISOString();

  await store.advanceCheckpoint({ consumerName: "hook-a", nextEventSeq: 5, updatedAt: now });
  await store.advanceCheckpoint({ consumerName: "hook-a", nextEventSeq: 3, updatedAt: now });
  const checkpoint = await store.getCheckpoint("hook-a");

  assert.equal(checkpoint?.lastEventSeq, 5);
});

test("requeueExpired resets stale claimed commands", async () => {
  const store = await makeStore();
  const now = new Date().toISOString();
  const workspace = await store.ensureWorkspace("/tmp/repo-d", now);
  const session = await store.createSession({ workspaceId: workspace.id, createdAt: now });

  await store.enqueueCommand({
    id: "cmd_3",
    workspaceId: workspace.id,
    sessionId: session.id,
    type: "review.submit",
    producer: "vscode",
    createdAt: now,
    availableAt: now,
    status: "pending",
    attemptCount: 0,
    payload: { stale: true },
  });

  const claimed = await store.claimCommand({ workerId: "worker-3", now, leaseDurationMs: 1 });
  const later = new Date(Date.parse(now) + 5_000).toISOString();
  const count = await store.requeueExpired(later);
  const command = await store.getById("cmd_3");

  assert.equal(claimed?.command.id, "cmd_3");
  assert.equal(count, 1);
  assert.equal(command?.status, "pending");
  assert.equal(command?.lease, undefined);
});
