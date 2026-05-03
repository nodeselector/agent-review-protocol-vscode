import * as vscode from "vscode";
import { captureGitDiffArtifact } from "./git-diff.js";
import { loadReviewStore } from "./review-store.js";
import type { AdapterReviewResult, ResolutionStatus } from "../../protocol/src/index.js";

export class ReviewStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private workspaceRoot?: string;
  private latestResult?: AdapterReviewResult;

  constructor() {
    this.item = vscode.window.createStatusBarItem("arp.review", vscode.StatusBarAlignment.Left, 100);
    this.item.name = "ARP Review";
    this.item.command = "arp.showLatestBusRevision";
    this.item.show();
    this.render();
  }

  async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    await this.refresh();
  }

  async setLatestResult(result: AdapterReviewResult | undefined): Promise<void> {
    this.latestResult = result;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.render(await this.loadCounts());
  }

  dispose(): void {
    this.item.dispose();
  }

  private async loadCounts(): Promise<{ comments: number; files: number }> {
    if (!this.workspaceRoot) {
      return { comments: 0, files: 0 };
    }

    try {
      const [store, artifact] = await Promise.all([
        loadReviewStore(this.workspaceRoot),
        captureGitDiffArtifact(this.workspaceRoot),
      ]);
      return { comments: store.comments.length, files: artifact.changedFiles.length };
    } catch {
      return { comments: 0, files: 0 };
    }
  }

  private render(counts: { comments: number; files: number } = { comments: 0, files: 0 }): void {
    if (!this.workspaceRoot) {
      this.item.text = "$(comment-discussion) ARP";
      this.item.tooltip = "ARP review inactive";
      this.item.command = "arp.startSession";
      return;
    }

    const summary = this.latestResult ? summarizeLatestResult(this.latestResult) : `${counts.comments} draft, ${counts.files} files`;
    this.item.text = `$(comment-discussion) ARP ${summary}`;
    this.item.tooltip = this.latestResult
      ? `ARP latest result: ${summary}`
      : `ARP review in progress: ${counts.comments} draft comments across ${counts.files} changed files`;
    this.item.command = this.latestResult ? "arp.showLatestBusRevision" : "arp.submitReview";
  }
}

function summarizeLatestResult(result: AdapterReviewResult): string {
  const counts = new Map<ResolutionStatus, number>();
  for (const resolution of result.revision.resolutions) {
    counts.set(resolution.status, (counts.get(resolution.status) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return `${result.mode}: no resolutions`;
  }

  const parts: string[] = [];
  for (const [status, count] of counts.entries()) {
    parts.push(`${count} ${status.replace(/_/g, " ")}`);
  }
  return `${result.mode}: ${parts.join(", ")}`;
}
