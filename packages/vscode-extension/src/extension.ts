import * as vscode from "vscode";
import { type CommentCategory } from "../../protocol/src/index.js";
import { sendJsonRpc } from "./rpc-client.js";
import { captureGitDiffArtifact } from "./git-diff.js";
import { enqueueDraftReviewToBus } from "./bus-review.js";
import {
  addDraftComment,
  clearDraftComments,
  ensureSession,
  formatDraftComments,
  loadReviewStore,
} from "./review-store.js";

const outputChannel = vscode.window.createOutputChannel("ARP");

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.startSession", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("No workspace folder open.");
        return;
      }

      try {
        const localSession = await ensureSession(workspaceRoot);
        const config = getExtensionConfig();
        const response = await sendJsonRpc(
          config.referenceServerCommand,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "session/create",
            params: { workspaceRoot },
          },
          { timeoutMs: config.referenceServerTimeoutMs },
        );

        logJson("startSession", response);
        void vscode.window.showInformationMessage(`ARP session ready: ${localSession.id}`);
      } catch (error) {
        void vscode.window.showErrorMessage(formatCommandError("start session", error));
      }
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

      const config = getExtensionConfig();
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

      if (!artifact.patch.trim() || artifact.changedFiles.length === 0) {
        void vscode.window.showWarningMessage("Current git diff is empty. Make a change before submitting review.");
        return;
      }

      try {
        const response = await sendJsonRpc(
          config.adapterCommand,
          {
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
          },
          { timeoutMs: config.adapterTimeoutMs },
        );

        logJson("submitReview", response);
        await showReviewResult(response, artifact.changedFiles.length, store.comments.length);
      } catch (error) {
        outputChannel.show(true);
        void vscode.window.showErrorMessage(formatCommandError("submit review", error));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.submitReviewToBus", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const config = getExtensionConfig();
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

      if (!artifact.patch.trim() || artifact.changedFiles.length === 0) {
        void vscode.window.showWarningMessage("Current git diff is empty. Make a change before submitting review.");
        return;
      }

      try {
        const result = await enqueueDraftReviewToBus({
          workspaceRoot,
          session,
          artifact,
          review: {
            event: "comment",
            summary: "Draft review from VS Code",
            comments: store.comments,
          },
          dbPath: config.busDbPath || undefined,
        });

        logJson("submitReviewToBus", result);
        const document = await vscode.workspace.openTextDocument({
          content: [
            "# ARP Review Enqueued",
            "",
            `- Command: ${result.commandId}`,
            `- Session: ${result.sessionId}`,
            `- Workspace: ${result.workspaceId}`,
            `- DB: ${result.dbPath}`,
            `- Changed files: ${artifact.changedFiles.length}`,
            `- Comments submitted: ${store.comments.length}`,
            "",
            "The review was enqueued into the local ARP bus.",
            "No worker is consuming `review.submit` yet.",
          ].join("\n"),
          language: "markdown",
        });
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        outputChannel.show(true);
        void vscode.window.showErrorMessage(formatCommandError("submit review to bus", error));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.showOutput", async () => {
      outputChannel.show(true);
    }),
  );
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getExtensionConfig(): {
  referenceServerCommand: string;
  adapterCommand: string;
  referenceServerTimeoutMs: number;
  adapterTimeoutMs: number;
  busDbPath: string;
} {
  const config = vscode.workspace.getConfiguration("arp");

  return {
    referenceServerCommand: config.get<string>("referenceServerCommand", "arp-reference-server"),
    adapterCommand: config.get<string>("adapterCommand", "arp-pi-adapter"),
    referenceServerTimeoutMs: config.get<number>("referenceServerTimeoutMs", 10000),
    adapterTimeoutMs: config.get<number>("adapterTimeoutMs", 60000),
    busDbPath: config.get<string>("busDbPath", ""),
  };
}

function formatCommandError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    return `Failed to ${action}: required command was not found on PATH.`;
  }

  return `Failed to ${action}: ${message}`;
}

function logJson(label: string, value: unknown): void {
  outputChannel.appendLine(`## ${label}`);
  outputChannel.appendLine(JSON.stringify(value, null, 2));
  outputChannel.appendLine("");
}

async function showReviewResult(response: any, changedFileCount: number, commentCount: number): Promise<void> {
  const result = response?.result ?? {};
  const revision = result.revision ?? {};
  const lines = [
    "# ARP Review Result",
    "",
    `- Adapter: ${result.adapter ?? "unknown"}`,
    `- Mode: ${result.mode ?? "unknown"}`,
    `- Changed files: ${changedFileCount}`,
    `- Comments submitted: ${commentCount}`,
    `- Normalized: ${String(result.normalized ?? false)}`,
    "",
    "## Summary",
    "",
    revision.summary ?? result.note ?? "No summary returned.",
    "",
    "## Resolutions",
    "",
  ];

  const resolutions = Array.isArray(revision.resolutions) ? revision.resolutions : [];
  if (resolutions.length === 0) {
    lines.push("- No resolutions returned.");
  } else {
    for (const resolution of resolutions) {
      lines.push(`- ${resolution.commentId}: ${resolution.status}${resolution.note ? ` - ${resolution.note}` : ""}`);
    }
  }

  if (Array.isArray(revision.questions) && revision.questions.length > 0) {
    lines.push("", "## Questions", "");
    for (const question of revision.questions) {
      lines.push(`- ${question}`);
    }
  }

  lines.push("", "## Raw JSON", "", "```json", JSON.stringify(response, null, 2), "```");

  const document = await vscode.workspace.openTextDocument({
    content: lines.join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

export function deactivate(): void {}
