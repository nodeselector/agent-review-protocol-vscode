#!/usr/bin/env node
import { processNextReviewCommand, type ProcessNextReviewCommandResult } from "./bus-worker.js";

export interface RunReviewWorkerLoopInput {
  dbPath: string;
  workerId?: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  maxIterations?: number;
  maxIdleIterations?: number;
  signal?: AbortSignal;
  onIteration?: (result: ProcessNextReviewCommandResult, iteration: number) => void | Promise<void>;
}

export interface RunReviewWorkerLoopResult {
  kind: "stopped";
  iterations: number;
  processedCount: number;
  idleCount: number;
  stopReason: "signal" | "max-iterations" | "max-idle-iterations";
}

export async function runReviewWorkerLoop(input: RunReviewWorkerLoopInput): Promise<RunReviewWorkerLoopResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  const maxIterations = input.maxIterations ?? Number.POSITIVE_INFINITY;
  const maxIdleIterations = input.maxIdleIterations ?? Number.POSITIVE_INFINITY;

  let iterations = 0;
  let processedCount = 0;
  let idleCount = 0;

  while (true) {
    if (input.signal?.aborted) {
      return { kind: "stopped", iterations, processedCount, idleCount, stopReason: "signal" };
    }

    if (iterations >= maxIterations) {
      return { kind: "stopped", iterations, processedCount, idleCount, stopReason: "max-iterations" };
    }

    const result = await processNextReviewCommand({
      dbPath: input.dbPath,
      workerId: input.workerId,
      leaseDurationMs: input.leaseDurationMs,
    });

    iterations += 1;
    if (result.kind === "processed") {
      processedCount += 1;
      idleCount = 0;
    } else {
      idleCount += 1;
    }

    await input.onIteration?.(result, iterations);

    if (idleCount >= maxIdleIterations) {
      return { kind: "stopped", iterations, processedCount, idleCount, stopReason: "max-idle-iterations" };
    }

    if (input.signal?.aborted) {
      return { kind: "stopped", iterations, processedCount, idleCount, stopReason: "signal" };
    }

    if (result.kind === "idle") {
      await sleep(pollIntervalMs, input.signal);
    }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      resolve();
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbFlagIndex = args.indexOf("--db");
  const pollFlagIndex = args.indexOf("--poll-ms");
  const idleFlagIndex = args.indexOf("--max-idle-iterations");
  const iterationFlagIndex = args.indexOf("--max-iterations");

  const dbPath = dbFlagIndex >= 0 ? args[dbFlagIndex + 1] : process.env.ARP_BUS_DB_PATH;
  if (!dbPath) {
    throw new Error("Missing bus DB path. Pass --db <path> or set ARP_BUS_DB_PATH.");
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  const result = await runReviewWorkerLoop({
    dbPath,
    pollIntervalMs: pollFlagIndex >= 0 ? Number(args[pollFlagIndex + 1]) : undefined,
    maxIdleIterations: idleFlagIndex >= 0 ? Number(args[idleFlagIndex + 1]) : undefined,
    maxIterations: iterationFlagIndex >= 0 ? Number(args[iterationFlagIndex + 1]) : undefined,
    signal: controller.signal,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
