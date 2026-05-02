import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createArtifactFromPatch,
  parseChangedFilesFromPatch,
  captureGitDiffArtifact,
} from "../dist/vscode-extension/src/git-diff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sampleDiffPath = path.join(repoRoot, "tests/fixtures/sample-review.diff");

test("parseChangedFilesFromPatch returns modified file entries", async () => {
  const sampleDiff = await fs.readFile(sampleDiffPath, "utf8");
  const changedFiles = parseChangedFilesFromPatch(sampleDiff);

  assert.deepEqual(changedFiles, [
    {
      path: "src/fs.ts",
      status: "modified",
    },
  ]);
});

test("createArtifactFromPatch includes patch and changed files", async () => {
  const sampleDiff = await fs.readFile(sampleDiffPath, "utf8");
  const artifact = createArtifactFromPatch(sampleDiff);

  assert.equal(artifact.type, "gitDiff");
  assert.equal(artifact.patch, sampleDiff);
  assert.equal(artifact.changedFiles.length, 1);
  assert.equal(artifact.changedFiles[0]?.path, "src/fs.ts");
});

test("captureGitDiffArtifact delegates to git and returns artifact", async () => {
  const sampleDiff = await fs.readFile(sampleDiffPath, "utf8");
  const calls = [];
  const artifact = await captureGitDiffArtifact(
    "/tmp/workspace",
    async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: sampleDiff, stderr: "" };
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "git");
  assert.deepEqual(calls[0]?.args, ["diff", "--no-ext-diff", "--unified=3"]);
  assert.equal(calls[0]?.options.cwd, "/tmp/workspace");
  assert.equal(artifact.patch, sampleDiff);
  assert.equal(artifact.changedFiles[0]?.path, "src/fs.ts");
});
