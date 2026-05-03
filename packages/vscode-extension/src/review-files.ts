import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as vscode from "vscode";
import { captureGitDiffArtifact } from "./git-diff.js";
import type { ChangedFile } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);
const BASE_SCHEME = "arp-base";
const EMPTY_SCHEME = "arp-empty";

export class ReviewFilesProvider implements vscode.TreeDataProvider<ReviewFileNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ReviewFileNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private workspaceRoot?: string;
  private files: ReviewFileNode[] = [];

  async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<void> {
    this.workspaceRoot = workspaceRoot;
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
      this.files = artifact.changedFiles.map((file) => new ReviewFileNode(file));
    } catch {
      this.files = [];
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: ReviewFileNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReviewFileNode): Thenable<ReviewFileNode[]> {
    return Promise.resolve(element ? [] : this.files);
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

export class ReviewFileNode extends vscode.TreeItem {
  constructor(public readonly file: ChangedFile) {
    super(file.path, vscode.TreeItemCollapsibleState.None);
    this.description = file.status;
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
