import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { type Artifact, type ChangedFile } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);

export interface ExecFileLikeResult {
  stdout: string;
  stderr: string;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number },
) => Promise<ExecFileLikeResult>;

export async function captureGitDiffArtifact(
  workspaceRoot: string,
  execImpl: ExecFileLike = (file, args, options) => execFileAsync(file, args, options),
): Promise<Artifact> {
  const { stdout } = await execImpl("git", ["diff", "--no-ext-diff", "--unified=3"], {
    cwd: workspaceRoot,
    maxBuffer: 10 * 1024 * 1024,
  });

  return createArtifactFromPatch(stdout);
}

export function createArtifactFromPatch(patch: string): Artifact {
  return {
    id: `art_${randomUUID()}`,
    type: "gitDiff",
    patch,
    changedFiles: parseChangedFilesFromPatch(patch),
  };
}

export interface PatchLineRange {
  startLine: number;
  endLine: number;
}

export function parseChangedFilesFromPatch(patch: string): ChangedFile[] {
  const lines = patch.split("\n");
  const changedFiles: ChangedFile[] = [];

  for (const line of lines) {
    if (!line.startsWith("diff --git a/")) {
      continue;
    }

    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const oldPath = match[1];
    const newPath = match[2];

    changedFiles.push({
      path: inferPath(oldPath, newPath),
      status: inferStatus(oldPath, newPath),
    });
  }

  return changedFiles;
}

export function parseCommentingRangesFromPatch(patch: string, targetPath: string): PatchLineRange[] {
  const lines = patch.split("\n");
  const ranges: PatchLineRange[] = [];
  let inTargetFile = false;

  for (const line of lines) {
    if (line.startsWith("diff --git a/")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      inTargetFile = Boolean(match && inferPath(match[1], match[2]) === targetPath);
      continue;
    }

    if (!inTargetFile || !line.startsWith("@@ ")) {
      continue;
    }

    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }

    const startLine = Number(match[1]);
    const lineCount = Number(match[2] ?? "1");
    if (lineCount <= 0) {
      continue;
    }

    ranges.push({
      startLine,
      endLine: startLine + lineCount - 1,
    });
  }

  return ranges;
}

function inferPath(oldPath: string, newPath: string): string {
  if (oldPath === "/dev/null") {
    return newPath;
  }

  if (newPath === "/dev/null") {
    return oldPath;
  }

  return newPath;
}

function inferStatus(oldPath: string, newPath: string): ChangedFile["status"] {
  if (oldPath === "/dev/null") {
    return "added";
  }

  if (newPath === "/dev/null") {
    return "deleted";
  }

  if (oldPath !== newPath) {
    return "renamed";
  }

  return "modified";
}
