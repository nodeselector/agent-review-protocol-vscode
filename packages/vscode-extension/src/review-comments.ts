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
import {
  getRelativePathFromReviewUri,
  isReviewDocumentUri,
} from "./review-files.js";
import type { AdapterReviewResult, Comment, CommentResolution, ResolutionStatus } from "../../protocol/src/index.js";

const COMMENT_CONTROLLER_ID = "arp-review";
const COMMENT_CONTEXT_VALUE = "arp-draft-comment";
const THREAD_CONTEXT_VALUE = "arp-draft-thread";

export class ReviewCommentsManager implements vscode.Disposable, vscode.CommentingRangeProvider {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread | vscode.CommentThread2>();
  private workspaceRoot?: string;
  private latestResult?: AdapterReviewResult;
  private hasActiveSession = false;
  private changedFiles = new Set<string>();

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
    await this.refreshChangedFiles();
    await this.refresh();
  }

  setHasActiveSession(hasActiveSession: boolean): void {
    this.hasActiveSession = hasActiveSession;
  }

  async setLatestResult(result: AdapterReviewResult | undefined): Promise<void> {
    this.latestResult = result;
    await this.refreshChangedFiles();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.clearThreads();
    if (!this.workspaceRoot) {
      return;
    }

    const store = await loadReviewStore(this.workspaceRoot);
    const resolutions = new Map(
      (this.latestResult?.revision.resolutions ?? []).map((resolution) => [resolution.commentId, resolution] as const),
    );

    for (const comment of store.comments) {
      const resolution = resolutions.get(comment.id);
      const comments: vscode.Comment[] = [new DraftReviewComment(comment)];
      if (resolution) {
        comments.push(new ResultProjectionComment(this.latestResult!, resolution));
      }

      const thread = this.controller.createCommentThread(
        createThreadUri(this.workspaceRoot, comment),
        toRange(comment),
        comments,
      );
      thread.contextValue = THREAD_CONTEXT_VALUE;
      thread.label = buildThreadLabel(comment, resolution);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.state = mapThreadState(resolution?.status);
      this.threads.set(comment.id, thread);
    }
  }

  async provideCommentingRanges(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CommentingRanges | undefined> {
    if (!this.workspaceRoot || !this.hasActiveSession) {
      return undefined;
    }

    const relativePath = getRelativePathForUri(this.workspaceRoot, document.uri);
    if (!relativePath) {
      return undefined;
    }

    if (isArpReviewDiffDocument(document.uri)) {
      const artifact = await captureGitDiffArtifact(this.workspaceRoot);
      const ranges = parseCommentingRangesFromPatch(artifact.patch, relativePath).map(
        (range) => new vscode.Range(range.startLine - 1, 0, range.endLine - 1, 0),
      );
      return {
        enableFileComments: ranges.length > 0,
        ranges,
      };
    }

    if (document.uri.scheme === "file" && this.changedFiles.has(relativePath)) {
      const artifact = await captureGitDiffArtifact(this.workspaceRoot);
      const ranges = parseCommentingRangesFromPatch(artifact.patch, relativePath).map(
        (range) => new vscode.Range(range.startLine - 1, 0, range.endLine - 1, 0),
      );
      if (ranges.length > 0) {
        return { enableFileComments: true, ranges };
      }
    }

    if (document.uri.scheme === "file") {
      const lastLine = Math.max(document.lineCount - 1, 0);
      return {
        enableFileComments: false,
        ranges: [new vscode.Range(0, 0, lastLine, 0)],
      };
    }

    return undefined;
  }

  async createOrReply(reply: vscode.CommentReply): Promise<Comment | undefined> {
    if (!this.workspaceRoot) {
      return undefined;
    }

    const body = reply.text.trim();
    if (!body) {
      return undefined;
    }

    await ensureSession(this.workspaceRoot);
    const relativePath = getRelativePathForUri(this.workspaceRoot, reply.thread.uri);
    if (!relativePath) {
      return undefined;
    }

    const range = normalizeReplyRange(reply.thread.uri, reply.thread.range);
    if (!range) {
      return undefined;
    }

    const artifact = await captureGitDiffArtifact(this.workspaceRoot);
    const isReviewRange = parseCommentingRangesFromPatch(artifact.patch, relativePath).some(
      (patchRange) => rangesOverlap(range.start.line + 1, range.end.line + 1, patchRange.startLine, patchRange.endLine),
    );

    const comment = await addDraftComment(this.workspaceRoot, {
      path: relativePath,
      side: "new",
      line: range.start.line + 1,
      endLine: range.end.line + 1,
      startLine: range.start.line + 1,
      body,
      category: "note",
      scope: isReviewRange ? "review" : "context",
    });

    await this.refresh();
    return comment;
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

  async applyRevisionResult(result: AdapterReviewResult | undefined): Promise<void> {
    await this.setLatestResult(result);
  }

  dispose(): void {
    this.clearThreads();
    this.controller.dispose();
  }

  private async refreshChangedFiles(): Promise<void> {
    this.changedFiles.clear();
    if (!this.workspaceRoot) {
      return;
    }
    try {
      const artifact = await captureGitDiffArtifact(this.workspaceRoot);
      for (const file of artifact.changedFiles) {
        this.changedFiles.add(file.path);
      }
    } catch {
      // ignore
    }
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
  readonly author: vscode.CommentAuthorInformation;
  readonly contextValue: string;
  readonly timestamp = new Date();
  readonly label?: string;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  body: string;
  readonly range: vscode.Range;
  private readonly originalBody: string;

  constructor(private readonly comment: Comment) {
    this.id = comment.id;
    this.author = { name: comment.status === "draft" ? "ARP draft" : "ARP submitted" };
    this.contextValue = comment.status === "draft" ? COMMENT_CONTEXT_VALUE : "arp-submitted-comment";
    this.body = comment.body;
    this.originalBody = comment.body;
    this.label = `${prettyCommentScope(comment)} - ${prettyCommentLocation(comment)} - ${comment.category ?? "note"}`;
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

export class ResultProjectionComment implements vscode.Comment {
  readonly author: vscode.CommentAuthorInformation = { name: "ARP result" };
  readonly contextValue = "arp-result-comment";
  readonly timestamp = new Date();
  readonly label: string;
  readonly mode = vscode.CommentMode.Preview;
  readonly body: vscode.MarkdownString;

  constructor(result: AdapterReviewResult, resolution: CommentResolution) {
    this.label = `${result.mode} - ${resolution.status}`;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${prettyResolutionStatus(resolution.status)}**`);
    if (resolution.note) {
      markdown.appendMarkdown(`\n\n${escapeMarkdown(resolution.note)}`);
    }
    if (result.revision.summary) {
      markdown.appendMarkdown(`\n\nSummary: ${escapeMarkdown(result.revision.summary)}`);
    }
    this.body = markdown;
  }
}

function toRange(comment: Pick<Comment, "line" | "startLine" | "endLine">): vscode.Range {
  const startLine = (comment.startLine ?? comment.line ?? 1) - 1;
  const endLine = (comment.endLine ?? comment.line ?? comment.startLine ?? 1) - 1;
  return new vscode.Range(startLine, 0, endLine, 0);
}

function getRelativePathForUri(workspaceRoot: string, uri: vscode.Uri): string | undefined {
  if (isReviewDocumentUri(uri)) {
    return getRelativePathFromReviewUri(uri);
  }

  const relative = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    return undefined;
  }
  return relative;
}

function createThreadUri(workspaceRoot: string, comment: Comment): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceRoot, comment.path));
}

function isArpReviewDiffDocument(documentUri: vscode.Uri): boolean {
  if (isReviewDocumentUri(documentUri)) {
    return true;
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) {
        continue;
      }
      if (tab.input.modified.toString() !== documentUri.toString()) {
        continue;
      }
      if (isReviewDocumentUri(tab.input.original)) {
        return true;
      }
    }
  }
  return false;
}

function asPlainText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

function normalizeReplyRange(uri: vscode.Uri, fallbackRange?: vscode.Range): vscode.Range | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === uri.toString() && !editor.selection.isEmpty) {
    return new vscode.Range(editor.selection.start.line, 0, editor.selection.end.line, 0);
  }
  return fallbackRange;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

function buildThreadLabel(comment: Comment, resolution?: CommentResolution): string {
  const scope = comment.scope === "context" ? "context" : "review";
  const prefix = comment.status === "draft" ? `ARP ${scope} draft` : `ARP ${scope} submitted`;
  if (!resolution) {
    return `${prefix} - ${comment.category ?? "note"}`;
  }

  return `${prefix} - ${comment.category ?? "note"} - ${prettyResolutionStatus(resolution.status)}`;
}

function mapThreadState(status?: ResolutionStatus): vscode.CommentThreadState {
  if (status === "addressed") {
    return vscode.CommentThreadState.Resolved;
  }

  return vscode.CommentThreadState.Unresolved;
}

function prettyCommentScope(comment: Comment): string {
  return (comment.scope ?? "review") === "context" ? "context" : "review";
}

function prettyCommentLocation(comment: Comment): string {
  const startLine = comment.startLine ?? comment.line ?? 1;
  const endLine = comment.endLine ?? comment.line ?? startLine;
  return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

function prettyResolutionStatus(status: ResolutionStatus): string {
  return status.replace(/_/g, " ");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`])/g, "\\$1");
}
