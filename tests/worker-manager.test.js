import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureBusWorkerLoopRunning,
  getBusWorkerLoopState,
  resolveDefaultBusWorkerLoopCommand,
  stopBusWorkerLoop,
} from "../packages/vscode-extension/dist/vscode-extension/src/worker-manager.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "arp-worker-manager-"));
}

test("resolveDefaultBusWorkerLoopCommand finds the local wrapper script", () => {
  const command = resolveDefaultBusWorkerLoopCommand();
  assert.ok(command);
  assert.match(command, /arp-pi-review/);
});

test("ensureBusWorkerLoopRunning starts a loop process and reuses it for the same db", async () => {
  const workspaceRoot = await makeWorkspace();
  const dbPath = path.join(workspaceRoot, ".arp", "bus", "arp.db");
  const command = "node -e \"setInterval(() => {}, 1000)\"";

  const first = await ensureBusWorkerLoopRunning({ workspaceRoot, dbPath, command, pollIntervalMs: 5 });
  const second = await ensureBusWorkerLoopRunning({ workspaceRoot, dbPath, command, pollIntervalMs: 5 });
  const state = getBusWorkerLoopState();

  assert.equal(first.status, "started");
  assert.equal(second.status, "already-running");
  assert.ok(first.pid);
  assert.equal(second.pid, first.pid);
  assert.equal(state.pid, first.pid);

  const stopped = await stopBusWorkerLoop();
  assert.equal(stopped.stopped, true);
});

test("ensureBusWorkerLoopRunning reports unavailable when no command can be resolved", async () => {
  const workspaceRoot = await makeWorkspace();
  const dbPath = path.join(workspaceRoot, ".arp", "bus", "arp.db");
  const result = await ensureBusWorkerLoopRunning({ workspaceRoot, dbPath, command: "" });

  assert.ok(["started", "unavailable"].includes(result.status));
  if (result.status === "started") {
    await stopBusWorkerLoop();
  }
});
