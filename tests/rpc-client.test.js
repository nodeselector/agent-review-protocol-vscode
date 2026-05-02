import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { sendJsonRpc } from "../dist/vscode-extension/src/rpc-client.js";

class FakeReadable extends EventEmitter {}

class FakeWritable {
  constructor() {
    this.buffer = "";
    this.ended = false;
  }

  write(chunk) {
    this.buffer += chunk;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
    this.stdin = new FakeWritable();
  }
}

function createSpawnSuccess(response) {
  return (command, args, options) => {
    const child = new FakeChild();
    process.nextTick(() => {
      child.stdout.emit("data", response);
      child.emit("close", 0);
    });
    child.command = command;
    child.args = args;
    child.options = options;
    return child;
  };
}

function createSpawnFailure({ stderr = "boom", code = 1 } = {}) {
  return () => {
    const child = new FakeChild();
    process.nextTick(() => {
      if (stderr) {
        child.stderr.emit("data", stderr);
      }
      child.emit("close", code);
    });
    return child;
  };
}

test("sendJsonRpc writes request and parses success response", async () => {
  let capturedChild;
  const spawnImpl = (command, args, options) => {
    capturedChild = createSpawnSuccess('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')(command, args, options);
    return capturedChild;
  };

  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "capabilities/get",
  };

  const response = await sendJsonRpc("arp-reference-server", request, { spawnImpl });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
  });
  assert.equal(capturedChild.stdin.buffer, `${JSON.stringify(request)}\n`);
  assert.equal(capturedChild.stdin.ended, true);
  assert.deepEqual(capturedChild.options, { stdio: ["pipe", "pipe", "pipe"] });
});

test("sendJsonRpc rejects on process failure with stderr", async () => {
  await assert.rejects(
    () => sendJsonRpc("arp-reference-server", { jsonrpc: "2.0", id: 2, method: "x" }, { spawnImpl: createSpawnFailure({ stderr: "adapter failed" }) }),
    /adapter failed/,
  );
});

test("sendJsonRpc rejects on invalid JSON response", async () => {
  await assert.rejects(
    () => sendJsonRpc("arp-reference-server", { jsonrpc: "2.0", id: 3, method: "x" }, { spawnImpl: createSpawnSuccess("not json") }),
    /Unexpected token|invalid JSON-RPC response/,
  );
});

test("sendJsonRpc rejects on empty successful response", async () => {
  await assert.rejects(
    () => sendJsonRpc("arp-reference-server", { jsonrpc: "2.0", id: 4, method: "x" }, { spawnImpl: createSpawnSuccess("") }),
    /invalid JSON-RPC response/,
  );
});
