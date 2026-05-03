import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addDraftComment,
  clearDraftComments,
  ensureSession,
  formatDraftComments,
  getActiveDraftComments,
  getStorePath,
  loadReviewStore,
  markDraftCommentsSubmitted,
  removeDraftComment,
  updateDraftComment,
} from "../packages/vscode-extension/dist/vscode-extension/src/review-store.js";

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "arp-store-"));
}

test("ensureSession creates and persists a session", async () => {
  const workspaceRoot = await makeWorkspace();
  const session = await ensureSession(workspaceRoot);
  const store = await loadReviewStore(workspaceRoot);

  assert.match(session.id, /^sess_/);
  assert.equal(store.session?.id, session.id);
  assert.equal(store.comments.length, 0);
});

test("addDraftComment appends draft comments to the store", async () => {
  const workspaceRoot = await makeWorkspace();
  await ensureSession(workspaceRoot);

  const comment = await addDraftComment(workspaceRoot, {
    path: "src/fs.ts",
    side: "new",
    line: 84,
    body: "Preserve root slash semantics.",
    category: "blocking",
  });

  const store = await loadReviewStore(workspaceRoot);
  assert.match(comment.id, /^c_/);
  assert.equal(comment.status, "draft");
  assert.equal(store.comments.length, 1);
  assert.equal(store.comments[0]?.body, "Preserve root slash semantics.");
});

test("updateDraftComment updates an existing draft", async () => {
  const workspaceRoot = await makeWorkspace();
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/fs.ts",
    side: "new",
    line: 84,
    body: "Preserve root slash semantics.",
    category: "blocking",
  });

  const updated = await updateDraftComment(workspaceRoot, comment.id, {
    body: "Preserve root slash semantics carefully.",
    category: "note",
  });

  assert.equal(updated.body, "Preserve root slash semantics carefully.");
  assert.equal(updated.category, "note");
});

test("removeDraftComment removes one draft comment", async () => {
  const workspaceRoot = await makeWorkspace();
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/fs.ts",
    side: "new",
    line: 84,
    body: "Preserve root slash semantics.",
    category: "blocking",
  });

  await removeDraftComment(workspaceRoot, comment.id);
  const store = await loadReviewStore(workspaceRoot);
  assert.equal(store.comments.length, 0);
});

test("markDraftCommentsSubmitted moves active drafts out of the next review", async () => {
  const workspaceRoot = await makeWorkspace();
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/fs.ts",
    side: "new",
    startLine: 112,
    endLine: 130,
    body: "Extract this branch.",
    category: "note",
  });

  const submitted = await markDraftCommentsSubmitted(workspaceRoot, [comment.id]);
  const store = await loadReviewStore(workspaceRoot);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.status, "submitted");
  assert.equal(store.comments.length, 1);
  assert.equal(store.comments[0]?.status, "submitted");
  assert.equal(getActiveDraftComments(store).length, 0);
});

test("clearDraftComments removes only active draft comments", async () => {
  const workspaceRoot = await makeWorkspace();
  const comment = await addDraftComment(workspaceRoot, {
    path: "src/fs.ts",
    side: "new",
    startLine: 112,
    endLine: 130,
    body: "Extract this branch.",
    category: "note",
  });
  await markDraftCommentsSubmitted(workspaceRoot, [comment.id]);
  await addDraftComment(workspaceRoot, {
    path: "src/fs.ts",
    side: "new",
    line: 200,
    body: "Fresh draft.",
    category: "issue",
  });

  await clearDraftComments(workspaceRoot);
  const store = await loadReviewStore(workspaceRoot);
  assert.equal(store.comments.length, 1);
  assert.equal(store.comments[0]?.status, "submitted");
});

test("formatDraftComments renders readable output", () => {
  const rendered = formatDraftComments([
    {
      id: "c_1",
      path: "src/fs.ts",
      side: "new",
      line: 84,
      body: "Preserve root slash semantics.",
      category: "blocking",
      status: "draft",
    },
  ]);

  assert.match(rendered, /1\. src\/fs.ts:84 \[review\/blocking\] Preserve root slash semantics\./);
});

test("formatDraftComments renders multi-line ranges", () => {
  const rendered = formatDraftComments([
    {
      id: "c_2",
      path: "src/fs.ts",
      side: "new",
      startLine: 12,
      endLine: 18,
      body: "This whole block already exists elsewhere.",
      category: "note",
      scope: "context",
      status: "draft",
    },
  ]);

  assert.match(rendered, /1\. src\/fs.ts:12-18 \[context\/note\] This whole block already exists elsewhere\./);
});

test("getStorePath uses .arp reviews directory", () => {
  assert.equal(getStorePath("/tmp/repo"), "/tmp/repo/.arp/reviews/draft-review.json");
});
