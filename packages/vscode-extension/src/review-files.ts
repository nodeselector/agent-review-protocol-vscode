import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import * as vscode from "vscode";
import { captureGitDiffArtifact } from "./git-diff.js";
import { loadReviewStore } from "./review-store.js";
import type { AdapterReviewResult, ChangedFile, CommentResolution, ResolutionStatus } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);
const REVIEW_SCHEME = "arp-review";

export interface ReviewDocumentQuery {
  side: "base" | "working" | "empty";
}

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

export class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = parseReviewDocumentQuery(uri);
    if (query.side === "empty") {
      return "";
    }

    const workspaceRoot = uri.authority;
    const filePath = getRelativePathFromReviewUri(uri);

    try {
      if (query.side === "base") {
        const { stdout } = await execFileAsync("git", ["show", `HEAD:${filePath}`], {
          cwd: workspaceRoot,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      }

      return await fs.readFile(path.join(workspaceRoot, filePath), "utf8");
    } catch {
      return "";
    }
  }
}

export function createReviewDiffUris(workspaceRoot: string, file: ChangedFile): { left: vscode.Uri; right: vscode.Uri } {
  switch (file.status) {
    case "added":
      return {
        left: createReviewDocumentUri(workspaceRoot, file.path, "empty"),
        right: createReviewDocumentUri(workspaceRoot, file.path, "working"),
      };
    case "deleted":
      return {
        left: createReviewDocumentUri(workspaceRoot, file.path, "base"),
        right: createReviewDocumentUri(workspaceRoot, file.path, "empty"),
      };
    default:
      return {
        left: createReviewDocumentUri(workspaceRoot, file.path, "base"),
        right: createReviewDocumentUri(workspaceRoot, file.path, "working"),
      };
  }
}

export function createReviewDocumentUri(
  workspaceRoot: string,
  relativePath: string,
  side: ReviewDocumentQuery["side"],
): vscode.Uri {
  return vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    authority: workspaceRoot,
    path: `/${relativePath.replace(/\\/g, "/")}`,
    query: JSON.stringify({ side } satisfies ReviewDocumentQuery),
  });
}

export function isReviewDocumentUri(uri: vscode.Uri): boolean {
  return uri.scheme === REVIEW_SCHEME;
}

export function getRelativePathFromReviewUri(uri: vscode.Uri): string {
  return uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
}

export function parseReviewDocumentQuery(uri: vscode.Uri): ReviewDocumentQuery {
  try {
    return JSON.parse(uri.query) as ReviewDocumentQuery;
  } catch {
    return { side: "working" };
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

export const REVIEW_SCHEME_NAME = REVIEW_SCHEME;

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
