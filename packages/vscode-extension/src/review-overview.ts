import * as vscode from "vscode";
import { captureGitDiffArtifact } from "./git-diff.js";
import { getActiveDraftComments, loadReviewStore, type ReviewStore } from "./review-store.js";
import type { AdapterReviewResult, Comment, ResolutionStatus, Session } from "../../protocol/src/index.js";

export interface ReviewOverviewState {
  session?: Session;
  draftComments: Comment[];
  changedFileCount: number;
  latestResult?: AdapterReviewResult;
}

export class ReviewOverviewProvider implements vscode.TreeDataProvider<ReviewOverviewNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ReviewOverviewNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private workspaceRoot?: string;
  private state: ReviewOverviewState = {
    draftComments: [],
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
      this.state = { draftComments: [], changedFileCount: 0 };
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    const store = await loadSafeReviewStore(this.workspaceRoot);
    const changedFileCount = await loadChangedFileCount(this.workspaceRoot);
    this.state = {
      ...this.state,
      session: store.session,
      draftComments: sortDraftComments(getActiveDraftComments(store)),
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
      return Promise.resolve(element.children ?? []);
    }

    return Promise.resolve(buildOverviewNodes(this.state));
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

export class ReviewOverviewNode extends vscode.TreeItem {
  constructor(
    label: string,
    options: {
      description?: string;
      command?: vscode.Command;
      icon?: string;
      collapsibleState?: vscode.TreeItemCollapsibleState;
      tooltip?: string;
      children?: ReviewOverviewNode[];
    } = {},
  ) {
    super(label, options.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    this.description = options.description;
    this.command = options.command;
    this.tooltip = options.tooltip;
    this.iconPath = options.icon ? new vscode.ThemeIcon(options.icon) : undefined;
    this.children = options.children;
  }

  readonly children?: ReviewOverviewNode[];
}

function buildOverviewNodes(state: ReviewOverviewState): ReviewOverviewNode[] {
  const nodes: ReviewOverviewNode[] = [];

  nodes.push(
    new ReviewOverviewNode("Session", {
      description: state.session?.id ?? "not started",
      command: { command: "arp.startSession", title: "Start Session" },
      icon: "history",
    }),
  );

  nodes.push(buildDraftCommentsNode(state.draftComments));

  nodes.push(
    new ReviewOverviewNode("Changed files", {
      description: String(state.changedFileCount),
      command: { command: "arp.openNextReviewFile", title: "Open Next Review File" },
      icon: "files",
    }),
  );

  if (state.latestResult) {
    nodes.push(
      new ReviewOverviewNode("Latest result", {
        description: `${state.latestResult.mode} - ${summarizeLatestResult(state.latestResult)}`,
        command: { command: "arp.showLatestBusRevision", title: "Show Latest Bus Revision" },
        icon: state.latestResult.mode === "live" ? "sparkle" : "check",
      }),
    );
  } else {
    nodes.push(
      new ReviewOverviewNode("Latest result", {
        description: "none yet",
        command: { command: "arp.showLatestBusRevision", title: "Show Latest Bus Revision" },
        icon: "circle-large-outline",
      }),
    );
  }

  nodes.push(
    new ReviewOverviewNode("Submit review", {
      description: state.draftComments.length > 0 ? `${state.draftComments.length} draft comments ready` : "no draft comments",
      command: { command: "arp.submitReview", title: "Submit Review" },
      icon: "send",
    }),
  );

  return nodes;
}

function buildDraftCommentsNode(draftComments: Comment[]): ReviewOverviewNode {
  if (draftComments.length === 0) {
    return new ReviewOverviewNode("Draft comments", {
      description: "0",
      icon: "comment-discussion",
    });
  }

  const children = draftComments.map((comment) => {
    const line = comment.line ?? comment.startLine ?? 1;
    return new ReviewOverviewNode(truncate(comment.body), {
      description: `${comment.path}:${line}`,
      tooltip: `${comment.path}:${line}\n\n${comment.body}`,
      command: {
        command: "arp.openOverviewDraftComment",
        title: "Open Draft Comment",
        arguments: [comment],
      },
      icon: iconForCategory(comment.category),
    });
  });

  return new ReviewOverviewNode("Draft comments", {
    description: String(draftComments.length),
    icon: "comment-discussion",
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    children,
  });
}

function sortDraftComments(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return (a.line ?? a.startLine ?? 0) - (b.line ?? b.startLine ?? 0);
  });
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

function truncate(text: string, max = 48): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function iconForCategory(category?: Comment["category"]): string {
  switch (category) {
    case "blocking":
      return "error";
    case "issue":
      return "warning";
    default:
      return "comment";
  }
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
