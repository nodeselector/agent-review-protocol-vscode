import * as vscode from "vscode";
import { captureGitDiffArtifact } from "./git-diff.js";
import { loadReviewStore, type ReviewStore } from "./review-store.js";
import type { AdapterReviewResult, ResolutionStatus, Session } from "../../protocol/src/index.js";

export interface ReviewOverviewState {
  session?: Session;
  draftCommentCount: number;
  changedFileCount: number;
  latestResult?: AdapterReviewResult;
}

export class ReviewOverviewProvider implements vscode.TreeDataProvider<ReviewOverviewNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ReviewOverviewNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private workspaceRoot?: string;
  private state: ReviewOverviewState = {
    draftCommentCount: 0,
    changedFileCount: 0,
  };

  async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    await this.refresh();
  }

  async setLatestResult(result: AdapterReviewResult | undefined): Promise<void> {
    this.state = {
      ...this.state,
      latestResult: result,
    };
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async refresh(): Promise<void> {
    if (!this.workspaceRoot) {
      this.state = { draftCommentCount: 0, changedFileCount: 0 };
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    const store = await loadSafeReviewStore(this.workspaceRoot);
    const changedFileCount = await loadChangedFileCount(this.workspaceRoot);
    this.state = {
      ...this.state,
      session: store.session,
      draftCommentCount: store.comments.length,
      changedFileCount,
    };
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async applyRevisionResult(result: AdapterReviewResult | undefined): Promise<void> {
    await this.setLatestResult(result);
  }

  getTreeItem(element: ReviewOverviewNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReviewOverviewNode): Thenable<ReviewOverviewNode[]> {
    if (element) {
      return Promise.resolve([]);
    }

    return Promise.resolve(buildOverviewNodes(this.state));
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

export class ReviewOverviewNode extends vscode.TreeItem {
  constructor(label: string, description?: string, command?: vscode.Command, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.command = command;
    this.iconPath = icon ? new vscode.ThemeIcon(icon) : undefined;
  }
}

function buildOverviewNodes(state: ReviewOverviewState): ReviewOverviewNode[] {
  const nodes: ReviewOverviewNode[] = [];

  nodes.push(
    new ReviewOverviewNode(
      "Session",
      state.session?.id ?? "not started",
      { command: "arp.startSession", title: "Start Session" },
      "history",
    ),
  );

  nodes.push(
    new ReviewOverviewNode(
      "Draft comments",
      String(state.draftCommentCount),
      { command: "arp.showDraftComments", title: "Show Draft Comments" },
      "comment-discussion",
    ),
  );

  nodes.push(
    new ReviewOverviewNode(
      "Changed files",
      String(state.changedFileCount),
      undefined,
      "files",
    ),
  );

  if (state.latestResult) {
    nodes.push(
      new ReviewOverviewNode(
        "Latest result",
        `${state.latestResult.mode} - ${summarizeLatestResult(state.latestResult)}`,
        { command: "arp.showLatestBusRevision", title: "Show Latest Bus Revision" },
        state.latestResult.mode === "live" ? "sparkle" : "check",
      ),
    );
  } else {
    nodes.push(
      new ReviewOverviewNode(
        "Latest result",
        "none yet",
        { command: "arp.showLatestBusRevision", title: "Show Latest Bus Revision" },
        "circle-large-outline",
      ),
    );
  }

  nodes.push(
    new ReviewOverviewNode(
      "Submit review",
      state.draftCommentCount > 0 ? `${state.draftCommentCount} draft comments ready` : "no draft comments",
      { command: "arp.submitReview", title: "Submit Review" },
      "send",
    ),
  );

  return nodes;
}

function summarizeLatestResult(result: AdapterReviewResult): string {
  const counts = new Map<ResolutionStatus, number>();
  for (const resolution of result.revision.resolutions) {
    counts.set(resolution.status, (counts.get(resolution.status) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return "no resolutions";
  }

  const parts: string[] = [];
  for (const [status, count] of counts.entries()) {
    parts.push(`${count} ${status.replace(/_/g, " ")}`);
  }
  return parts.join(", ");
}

async function loadSafeReviewStore(workspaceRoot: string): Promise<ReviewStore> {
  try {
    return await loadReviewStore(workspaceRoot);
  } catch {
    return { comments: [] };
  }
}

async function loadChangedFileCount(workspaceRoot: string): Promise<number> {
  try {
    const artifact = await captureGitDiffArtifact(workspaceRoot);
    return artifact.changedFiles.length;
  } catch {
    return 0;
  }
}
