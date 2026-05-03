import * as vscode from "vscode";
import { captureGitDiffArtifact, parseCommentingRangesFromPatch } from "./git-diff.js";
import path from "node:path";

export class ReviewCommentCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private workspaceRoot?: string;
  private hasActiveSession = false;

  setWorkspaceRoot(workspaceRoot: string | undefined): void {
    this.workspaceRoot = workspaceRoot;
    this.refresh();
  }

  setHasActiveSession(hasActiveSession: boolean): void {
    this.hasActiveSession = hasActiveSession;
    this.refresh();
  }

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.workspaceRoot || !this.hasActiveSession || document.uri.scheme !== "file") {
      return [];
    }

    const relativePath = normalizeRelativePath(this.workspaceRoot, document.uri.fsPath);
    if (!relativePath) {
      return [];
    }

    try {
      const artifact = await captureGitDiffArtifact(this.workspaceRoot);
      return parseCommentingRangesFromPatch(artifact.patch, relativePath).map((range) => {
        const line = range.startLine - 1;
        const targetRange = new vscode.Range(line, 0, line, 0);
        return new vscode.CodeLens(targetRange, {
          command: "arp.addDraftCommentAtRange",
          title: "$(comment-add) Add ARP draft comment",
          arguments: [document.uri, targetRange],
        });
      });
    } catch {
      return [];
    }
  }
}

function normalizeRelativePath(workspaceRoot: string, fsPath: string): string | undefined {
  const relative = path.relative(workspaceRoot, fsPath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    return undefined;
  }
  return relative;
}
