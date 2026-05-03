import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as vscode from "vscode";
import { captureGitDiffArtifact } from "./git-diff.js";
import { loadReviewStore } from "./review-store.js";
import type { AdapterReviewResult, ChangedFile, CommentResolution, ResolutionStatus } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);
const BASE_SCHEME = "arp-base";
const EMPTY_SCHEME = "arp-empty";

export class ReviewFilesProvider implements vscode.TreeDataProvider<ReviewFileNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ReviewFileNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private workspaceRoot?: string;
  private files: ReviewFileNode[] = [];
  private latestResult?: AdapterReviewResult;

  async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    await this.refresh();
  }

  async setLatestResult(result: AdapterReviewResult | undefined): Promise<void> {
    this.latestResult = result;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.workspaceRoot) {
      this.files = [];
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    try {
      const artifact = await captureGitDiffArtifact(this.workspaceRoot);
      const store = await loadReviewStore(this.workspaceRoot);
      const resolutions = new Map(
        (this.latestResult?.revision.resolutions ?? []).map((resolution) => [resolution.commentId, resolution] as const),
      );

      this.files = artifact.changedFiles
        .map((file) => {
          const draftComments = store.comments.filter((comment) => comment.path === file.path);
          const fileResolutions = draftComments
            .map((comment) => resolutions.get(comment.id))
            .filter((resolution): resolution is CommentResolution => Boolean(resolution));
          return new ReviewFileNode(file, buildFileReviewSummary(draftComments.length, fileResolutions));
        })
        .sort(compareReviewFileNodes);
    } catch {
      this.files = [];
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: ReviewFileNode): vscode.TreeItem {
    return element;
  }

  getFirstPendingFile(): ReviewFileNode | undefined {
    return this.files.find((file) => file.pendingCount > 0 || file.commentCount > 0) ?? this.files[0];
  }

  getChildren(element?: ReviewFileNode): Thenable<ReviewFileNode[]> {
    return Promise.resolve(element ? [] : this.files);
  }

  async applyRevisionResult(result: AdapterReviewResult | undefined): Promise<void> {
    await this.setLatestResult(result);
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

export interface ReviewFileSummary {
  text?: string;
  commentCount: number;
  addressedCount: number;
  pendingCount: number;
}

export class ReviewFileNode extends vscode.TreeItem {
  readonly commentCount: number;
  readonly addressedCount: number;
  readonly pendingCount: number;

  constructor(public readonly file: ChangedFile, summary: ReviewFileSummary) {
    super(file.path, vscode.TreeItemCollapsibleState.None);
    this.commentCount = summary.commentCount;
    this.addressedCount = summary.addressedCount;
    this.pendingCount = summary.pendingCount;
    this.description = summary.text ? `${file.status} - ${summary.text}` : file.status;
    this.contextValue = "arp-review-file";
    this.command = {
      command: "arp.openReviewFileDiff",
      title: "Open Review File Diff",
      arguments: [this],
    };
    this.iconPath = new vscode.ThemeIcon(iconForStatus(file.status));
  }
}

export class ReviewBaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === EMPTY_SCHEME) {
      return "";
    }

    const workspaceRoot = uri.authority;
    const filePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;

    try {
      const { stdout } = await execFileAsync("git", ["show", `HEAD:${filePath}`], {
        cwd: workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "";
    }
  }
}

export function createReviewDiffUris(workspaceRoot: string, file: ChangedFile): { left: vscode.Uri; right: vscode.Uri } {
  const relativePath = file.path.replace(/\\/g, "/");
  const baseUri = vscode.Uri.from({ scheme: BASE_SCHEME, authority: workspaceRoot, path: `/${relativePath}` });
  const emptyUri = vscode.Uri.from({ scheme: EMPTY_SCHEME, authority: workspaceRoot, path: `/${relativePath}` });
  const workspaceUri = vscode.Uri.file(path.join(workspaceRoot, relativePath));

  switch (file.status) {
    case "added":
      return { left: emptyUri, right: workspaceUri };
    case "deleted":
      return { left: baseUri, right: emptyUri };
    default:
      return { left: baseUri, right: workspaceUri };
  }
}

function iconForStatus(status: ChangedFile["status"]): string {
  switch (status) {
    case "added":
      return "diff-added";
    case "deleted":
      return "diff-removed";
    case "renamed":
      return "diff-renamed";
    default:
      return "diff-modified";
  }
}

export const REVIEW_BASE_SCHEME = BASE_SCHEME;
export const REVIEW_EMPTY_SCHEME = EMPTY_SCHEME;

function buildFileReviewSummary(commentCount: number, resolutions: CommentResolution[]): ReviewFileSummary {
  if (commentCount === 0) {
    return { commentCount: 0, addressedCount: 0, pendingCount: 0 };
  }

  const counts = new Map<ResolutionStatus, number>();
  for (const resolution of resolutions) {
    counts.set(resolution.status, (counts.get(resolution.status) ?? 0) + 1);
  }

  const addressedCount = counts.get("addressed") ?? 0;
  const pendingCount =
    (counts.get("partially_addressed") ?? 0) +
    (counts.get("not_addressed") ?? 0) +
    (counts.get("needs_clarification") ?? 0);

  const parts = [`${commentCount} comment${commentCount === 1 ? "" : "s"}`];
  if (addressedCount > 0) {
    parts.push(`${addressedCount} addressed`);
  }
  if (pendingCount > 0) {
    parts.push(`${pendingCount} pending`);
  }

  return {
    text: parts.join(", "),
    commentCount,
    addressedCount,
    pendingCount,
  };
}

function compareReviewFileNodes(a: ReviewFileNode, b: ReviewFileNode): number {
  if (a.pendingCount !== b.pendingCount) {
    return b.pendingCount - a.pendingCount;
  }
  if (a.commentCount !== b.commentCount) {
    return b.commentCount - a.commentCount;
  }
  return a.file.path.localeCompare(b.file.path);
}
