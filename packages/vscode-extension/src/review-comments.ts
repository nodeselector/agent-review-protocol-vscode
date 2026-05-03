import * as vscode from "vscode";
import path from "node:path";
import {
  addDraftComment,
  clearDraftComments,
  ensureSession,
  loadReviewStore,
  removeDraftComment,
  updateDraftComment,
} from "./review-store.js";
import { captureGitDiffArtifact, parseCommentingRangesFromPatch } from "./git-diff.js";
import type { Comment } from "../../protocol/src/index.js";

const COMMENT_CONTROLLER_ID = "arp-review";
const COMMENT_CONTEXT_VALUE = "arp-draft-comment";
const THREAD_CONTEXT_VALUE = "arp-draft-thread";

export class ReviewCommentsManager implements vscode.Disposable, vscode.CommentingRangeProvider {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private workspaceRoot?: string;

  constructor() {
    this.controller = vscode.comments.createCommentController(COMMENT_CONTROLLER_ID, "ARP Review");
    this.controller.options = {
      prompt: "Create ARP draft comment",
      placeHolder: "Explain the feedback for this change",
    };
    this.controller.commentingRangeProvider = this;
  }

  async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.clearThreads();
    if (!this.workspaceRoot) {
      return;
    }

    const store = await loadReviewStore(this.workspaceRoot);
    for (const comment of store.comments) {
      const thread = this.controller.createCommentThread(
        vscode.Uri.file(path.join(this.workspaceRoot, comment.path)),
        toRange(comment),
        [new DraftReviewComment(comment)],
      );
      thread.contextValue = THREAD_CONTEXT_VALUE;
      thread.label = `ARP draft - ${comment.category ?? "note"}`;
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.state = vscode.CommentThreadState.Unresolved;
      this.threads.set(comment.id, thread);
    }
  }

  async provideCommentingRanges(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CommentingRanges | undefined> {
    if (!this.workspaceRoot) {
      return undefined;
    }

    const relativePath = normalizeRelativePath(this.workspaceRoot, document.uri.fsPath);
    if (!relativePath) {
      return undefined;
    }

    const artifact = await captureGitDiffArtifact(this.workspaceRoot);
    const ranges = parseCommentingRangesFromPatch(artifact.patch, relativePath).map(
      (range) => new vscode.Range(range.startLine - 1, 0, range.endLine - 1, 0),
    );

    if (ranges.length === 0) {
      return { enableFileComments: false, ranges: [] };
    }

    return { enableFileComments: false, ranges };
  }

  async createOrReply(reply: vscode.CommentReply): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const body = reply.text.trim();
    if (!body) {
      return;
    }

    await ensureSession(this.workspaceRoot);
    const relativePath = normalizeRelativePath(this.workspaceRoot, reply.thread.uri.fsPath);
    if (!relativePath) {
      return;
    }

    const range = reply.thread.range;
    if (!range) {
      return;
    }

    await addDraftComment(this.workspaceRoot, {
      path: relativePath,
      side: "new",
      line: range.start.line + 1,
      endLine: range.end.line + 1,
      startLine: range.start.line + 1,
      body,
      category: "note",
    });

    await this.refresh();
  }

  edit(comment: DraftReviewComment): void {
    comment.startEdit();
    const thread = this.threads.get(comment.id);
    if (thread) {
      thread.comments = [comment];
    }
  }

  async save(comment: DraftReviewComment): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const body = asPlainText(comment.body).trim();
    if (!body) {
      await this.delete(comment);
      return;
    }

    await updateDraftComment(this.workspaceRoot, comment.id, {
      body,
      line: comment.range.start.line + 1,
      startLine: comment.range.start.line + 1,
      endLine: comment.range.end.line + 1,
    });
    comment.finishEdit(body);
    await this.refresh();
  }

  cancel(comment: DraftReviewComment): void {
    comment.cancelEdit();
    const thread = this.threads.get(comment.id);
    if (thread) {
      thread.comments = [comment];
    }
  }

  async delete(comment: DraftReviewComment): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    await removeDraftComment(this.workspaceRoot, comment.id);
    await this.refresh();
  }

  async clear(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }
    await clearDraftComments(this.workspaceRoot);
    await this.refresh();
  }

  dispose(): void {
    this.clearThreads();
    this.controller.dispose();
  }

  private clearThreads(): void {
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();
  }
}

export class DraftReviewComment implements vscode.Comment {
  readonly id: string;
  readonly author: vscode.CommentAuthorInformation = { name: "ARP draft" };
  readonly contextValue = COMMENT_CONTEXT_VALUE;
  readonly timestamp = new Date();
  readonly label?: string;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  body: string;
  readonly range: vscode.Range;
  private readonly originalBody: string;

  constructor(private readonly comment: Comment) {
    this.id = comment.id;
    this.body = comment.body;
    this.originalBody = comment.body;
    this.label = comment.category ?? "note";
    this.range = toRange(comment);
  }

  startEdit(): void {
    this.mode = vscode.CommentMode.Editing;
  }

  finishEdit(body: string): void {
    this.body = body;
    this.mode = vscode.CommentMode.Preview;
  }

  cancelEdit(): void {
    this.body = this.originalBody;
    this.mode = vscode.CommentMode.Preview;
  }
}

function toRange(comment: Pick<Comment, "line" | "startLine" | "endLine">): vscode.Range {
  const startLine = (comment.startLine ?? comment.line ?? 1) - 1;
  const endLine = (comment.endLine ?? comment.line ?? comment.startLine ?? 1) - 1;
  return new vscode.Range(startLine, 0, endLine, 0);
}

function normalizeRelativePath(workspaceRoot: string, fsPath: string): string | undefined {
  const relative = path.relative(workspaceRoot, fsPath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    return undefined;
  }
  return relative;
}

function asPlainText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
