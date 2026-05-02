import * as vscode from "vscode";
import { type CommentCategory } from "../../protocol/src/index.js";
import { sendJsonRpc } from "./rpc-client.js";
import { captureGitDiffArtifact } from "./git-diff.js";
import {
  addDraftComment,
  clearDraftComments,
  ensureSession,
  formatDraftComments,
  loadReviewStore,
} from "./review-store.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("arp.startSession", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("No workspace folder open.");
        return;
      }

      const localSession = await ensureSession(workspaceRoot);
      const response = await sendJsonRpc("arp-reference-server", {
        jsonrpc: "2.0",
        id: 1,
        method: "session/create",
        params: { workspaceRoot },
      });

      void vscode.window.showInformationMessage(
        `ARP session ready: ${localSession.id} ${JSON.stringify(response)}`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.addDraftComment", async () => {
      const editor = vscode.window.activeTextEditor;
      const workspaceRoot = getWorkspaceRoot();
      if (!editor || !workspaceRoot) {
        void vscode.window.showErrorMessage("Open a file in a workspace first.");
        return;
      }

      const body = await vscode.window.showInputBox({
        prompt: "Draft review comment",
        placeHolder: "Explain the feedback for the current line",
        ignoreFocusOut: true,
      });
      if (!body) {
        return;
      }

      const category = (await vscode.window.showQuickPick(["note", "issue", "blocking"], {
        title: "Comment category",
        ignoreFocusOut: true,
      })) as CommentCategory | undefined;
      if (!category) {
        return;
      }

      const comment = await addDraftComment(workspaceRoot, {
        path: vscode.workspace.asRelativePath(editor.document.uri),
        side: "new",
        line: editor.selection.active.line + 1,
        body,
        category,
      });

      void vscode.window.showInformationMessage(`Draft comment added: ${comment.path}:${comment.line}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.showDraftComments", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("No workspace folder open.");
        return;
      }

      const store = await loadReviewStore(workspaceRoot);
      const rendered = formatDraftComments(store.comments);
      const document = await vscode.workspace.openTextDocument({
        content: rendered,
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.clearDraftComments", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("No workspace folder open.");
        return;
      }

      await clearDraftComments(workspaceRoot);
      void vscode.window.showInformationMessage("Cleared ARP draft comments.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.submitStubReview", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const session = await ensureSession(workspaceRoot);
      const store = await loadReviewStore(workspaceRoot);
      if (store.comments.length === 0) {
        void vscode.window.showWarningMessage("No draft comments to submit.");
        return;
      }

      let artifact;
      try {
        artifact = await captureGitDiffArtifact(workspaceRoot);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to capture git diff: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      const response = await sendJsonRpc("arp-pi-adapter", {
        jsonrpc: "2.0",
        id: 2,
        method: "review/submit",
        params: {
          sessionId: session.id,
          review: {
            event: "comment",
            summary: "Draft review from VS Code",
            comments: store.comments,
          },
          artifact,
        },
      });

      const document = await vscode.workspace.openTextDocument({
        content: JSON.stringify(response, null, 2),
        language: "json",
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
  );
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function deactivate(): void {}
