import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EnsureBusWorkerLoopRunningInput {
  workspaceRoot: string;
  dbPath: string;
  command?: string;
  pollIntervalMs?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface EnsureBusWorkerLoopRunningResult {
  status: "started" | "already-running" | "unavailable";
  command?: string;
  dbPath: string;
  pid?: number;
}

export interface StopBusWorkerLoopResult {
  stopped: boolean;
  pid?: number;
}

type WorkerState = {
  child: ChildProcess;
  dbPath: string;
  command: string;
};

let workerState: WorkerState | null = null;

export async function ensureBusWorkerLoopRunning(
  input: EnsureBusWorkerLoopRunningInput,
): Promise<EnsureBusWorkerLoopRunningResult> {
  if (workerState && !workerState.child.killed && workerState.child.exitCode === null) {
    if (workerState.dbPath === input.dbPath) {
      return {
        status: "already-running",
        command: workerState.command,
        dbPath: workerState.dbPath,
        pid: workerState.child.pid,
      };
    }

    await stopBusWorkerLoop();
  }

  const command = input.command || resolveDefaultBusWorkerLoopCommand();
  if (!command) {
    return { status: "unavailable", dbPath: input.dbPath };
  }

  const child = spawn(
    "/bin/sh",
    [
      "-lc",
      `${command} --db ${shellQuote(input.dbPath)} --poll-ms ${Number(input.pollIntervalMs ?? 1000)}`,
    ],
    {
      cwd: input.workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => input.onStdout?.(chunk.trimEnd()));
  child.stderr?.on("data", (chunk: string) => input.onStderr?.(chunk.trimEnd()));
  child.on("exit", () => {
    if (workerState?.child.pid === child.pid) {
      workerState = null;
    }
  });

  workerState = {
    child,
    dbPath: input.dbPath,
    command,
  };

  return {
    status: "started",
    command,
    dbPath: input.dbPath,
    pid: child.pid,
  };
}

export async function stopBusWorkerLoop(): Promise<StopBusWorkerLoopResult> {
  if (!workerState) {
    return { stopped: false };
  }

  const pid = workerState.child.pid;
  workerState.child.kill("SIGTERM");
  workerState = null;
  return { stopped: true, pid };
}

export function resolveDefaultBusWorkerLoopCommand(): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = currentDir;

  for (let i = 0; i < 8; i += 1) {
    const piReviewCandidate = path.join(dir, "scripts", "arp-pi-review");
    if (existsSync(piReviewCandidate)) {
      return shellQuote(piReviewCandidate);
    }
    const loopCandidate = path.join(dir, "scripts", "arp-bus-worker-loop");
    if (existsSync(loopCandidate)) {
      return shellQuote(loopCandidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export function getBusWorkerLoopState(): { pid?: number; dbPath?: string; command?: string } {
  return {
    pid: workerState?.child.pid,
    dbPath: workerState?.dbPath,
    command: workerState?.command,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
