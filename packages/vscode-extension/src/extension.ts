import * as vscode from "vscode";
import { type Comment, type CommentCategory } from "../../protocol/src/index.js";
import { sendJsonRpc } from "./rpc-client.js";
import { captureGitDiffArtifact, parseCommentingRangesFromPatch } from "./git-diff.js";
import {
  enqueueDraftReviewToBus,
  getCurrentBusEventSeq,
  getLatestRevisionFromBus,
  waitForRevisionFromBus,
} from "./bus-review.js";
import { ensureBusWorkerLoopRunning, stopBusWorkerLoop } from "./worker-manager.js";
import { ReviewCommentsManager, DraftReviewComment } from "./review-comments.js";
import { ReviewCommentCodeLensProvider } from "./review-comment-codelens.js";
import {
  createReviewDiffUris,
  ReviewFileNode,
  ReviewFilesProvider,
  REVIEW_SCHEME_NAME,
} from "./review-files.js";
import { ReviewFileSystemProvider } from "./review-filesystem.js";
import { ReviewOverviewProvider } from "./review-overview.js";
import { ReviewStatusBar } from "./review-status-bar.js";
import {
  addDraftComment,
  clearDraftComments,
  ensureSession,
  formatDraftComments,
  getActiveDraftComments,
  loadReviewStore,
  markDraftCommentsSubmitted,
} from "./review-store.js";
import { hydrateReviewSessionState } from "./review-session.js";

const outputChannel = vscode.window.createOutputChannel("ARP");

export function activate(context: vscode.ExtensionContext): void {
  const reviewComments = new ReviewCommentsManager();
  const reviewFiles = new ReviewFilesProvider();
  const reviewOverview = new ReviewOverviewProvider();
  const reviewStatusBar = new ReviewStatusBar();
  const reviewCommentCodeLensProvider = new ReviewCommentCodeLensProvider();
  const reviewFileSystemProvider = new ReviewFileSystemProvider();
  const reviewFilesView = vscode.window.createTreeView("arpReviewFiles", { treeDataProvider: reviewFiles });
  const reviewOverviewView = vscode.window.createTreeView("arpReviewOverview", { treeDataProvider: reviewOverview, showCollapseAll: false });
  context.subscriptions.push(
    outputChannel,
    reviewComments,
    reviewFiles,
    reviewOverview,
    reviewStatusBar,
    reviewFilesView,
    reviewOverviewView,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, reviewCommentCodeLensProvider),
    vscode.workspace.registerFileSystemProvider(REVIEW_SCHEME_NAME, reviewFileSystemProvider, { isReadonly: true }),
  );
  void initializeReviewUi(getWorkspaceRoot(), getExtensionConfig().busDbPath || undefined, {
    reviewComments,
    reviewFiles,
    reviewOverview,
    reviewStatusBar,
    reviewCommentCodeLensProvider,
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void initializeReviewUi(getWorkspaceRoot(), getExtensionConfig().busDbPath || undefined, {
        reviewComments,
        reviewFiles,
        reviewOverview,
        reviewStatusBar,
        reviewCommentCodeLensProvider,
      });
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      void stopBusWorkerLoop();
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.startSession", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("No workspace folder open.");
        return;
      }

      try {
        const localSession = await ensureSession(workspaceRoot);
        await initializeReviewUi(workspaceRoot, getExtensionConfig().busDbPath || undefined, {
          reviewComments,
          reviewFiles,
          reviewOverview,
          reviewStatusBar,
          reviewCommentCodeLensProvider,
        });
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
        reviewCommentCodeLensProvider.setHasActiveSession(true);
        reviewComments.setHasActiveSession(true);
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

      const comment = await promptAndCreateDraftComment(workspaceRoot, editor.document.uri, editor.selection);
      if (!comment) {
        return;
      }

      await reviewComments.refresh();
      await reviewFiles.refresh();
      await reviewOverview.refresh();
      await reviewStatusBar.refresh();
      reviewCommentCodeLensProvider.refresh();
      await revealDraftCommentInOverview(reviewOverviewView, reviewOverview, comment);
      void vscode.window.showInformationMessage(formatAddedCommentMessage(comment));
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
      const rendered = formatDraftComments(getActiveDraftComments(store));
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
      await reviewComments.refresh();
      await reviewFiles.refresh();
      await reviewOverview.refresh();
      await reviewStatusBar.refresh();
      reviewCommentCodeLensProvider.refresh();
      void vscode.window.showInformationMessage("Cleared ARP draft comments.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.submitReview", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const config = getExtensionConfig();
      const session = await ensureSession(workspaceRoot);
      const store = await loadReviewStore(workspaceRoot);
      const activeDraftComments = getActiveDraftComments(store);
      if (activeDraftComments.length === 0) {
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
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "ARP review",
            cancellable: false,
          },
          async (progress) => {
            const busDbPath = config.busDbPath || undefined;
            if (config.autoStartBusWorkerLoop) {
              progress.report({ message: "starting worker loop" });
              const worker = await ensureBusWorkerLoopRunning({
                workspaceRoot,
                dbPath: busDbPath ?? `${workspaceRoot}/.arp/bus/arp.db`,
                command: config.busWorkerLoopCommand || undefined,
                pollIntervalMs: config.busWorkerLoopPollIntervalMs,
                onStdout: (line) => logLine(`busWorkerLoop.stdout ${line}`),
                onStderr: (line) => logLine(`busWorkerLoop.stderr ${line}`),
              });
              logJson("busWorkerLoop", worker);
              if (worker.status === "started") {
                void vscode.window.showInformationMessage(`ARP worker started${worker.pid ? ` (pid ${worker.pid})` : ""}.`);
              }
            }

            progress.report({ message: "capturing bus checkpoint" });
            const afterSeq = await getCurrentBusEventSeq(workspaceRoot, busDbPath);

            progress.report({ message: "queueing review" });
            const result = await enqueueDraftReviewToBus({
              workspaceRoot,
              session,
              artifact,
              review: {
                event: "comment",
                summary: "Draft review from VS Code",
                comments: activeDraftComments,
              },
              dbPath: busDbPath,
            });

            logJson("submitReviewToBus", result);
            logLine(`queued review command ${result.commandId}`);

            await markDraftCommentsSubmitted(
              workspaceRoot,
              activeDraftComments.map((comment) => comment.id),
            );
            await reviewComments.refresh();
            await reviewFiles.refresh();
            await reviewOverview.refresh();
            await reviewStatusBar.refresh();
            reviewCommentCodeLensProvider.refresh();

            progress.report({ message: "waiting for review result" });
            const latest = await waitForRevisionFromBus({
              workspaceRoot,
              sessionId: session.id,
              commandId: result.commandId,
              dbPath: result.dbPath,
              afterSeq,
              timeoutMs: config.busWaitTimeoutMs,
              pollIntervalMs: config.busPollIntervalMs,
            });

            if (latest) {
              logJson("submitReviewToBus.result", latest);
              logLine(`received revision.proposed for ${result.commandId}`);
              await reviewComments.applyRevisionResult(latest.result);
              await reviewFiles.applyRevisionResult(latest.result);
              await reviewOverview.applyRevisionResult(latest.result);
              await reviewStatusBar.setLatestResult(latest.result);
              void vscode.window.showInformationMessage("ARP review result received. Threads and overview updated.");
              return;
            }

            logLine(`timed out waiting for revision.proposed for ${result.commandId}`);
            void vscode.window.showWarningMessage(
              "ARP review queued. No result arrived before the wait timeout.",
            );
          },
        );
      } catch (error) {
        outputChannel.show(true);
        void vscode.window.showErrorMessage(formatCommandError("submit review to bus", error));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.showLatestBusRevision", async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const config = getExtensionConfig();
      const session = await ensureSession(workspaceRoot);

      try {
        const latest = await getLatestRevisionFromBus(workspaceRoot, session.id, config.busDbPath || undefined);
        if (!latest) {
          void vscode.window.showWarningMessage("No revision.proposed events found for the current session.");
          return;
        }

        logJson("showLatestBusRevision", latest);
        await reviewComments.applyRevisionResult(latest.result);
        await reviewFiles.applyRevisionResult(latest.result);
        await reviewOverview.applyRevisionResult(latest.result);
        await reviewStatusBar.setLatestResult(latest.result);
        void vscode.window.showInformationMessage("Latest ARP revision loaded into the review UI.");
      } catch (error) {
        outputChannel.show(true);
        void vscode.window.showErrorMessage(formatCommandError("show latest bus revision", error));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.addDraftCommentAtRange", async (uri: vscode.Uri, range: vscode.Range) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const comment = await promptAndCreateDraftComment(workspaceRoot, uri, range);
      if (!comment) {
        return;
      }

      await reviewComments.refresh();
      await reviewFiles.refresh();
      await reviewOverview.refresh();
      await reviewStatusBar.refresh();
      reviewCommentCodeLensProvider.refresh();
      await revealDraftCommentInOverview(reviewOverviewView, reviewOverview, comment);
      void vscode.window.showInformationMessage(formatAddedCommentMessage(comment));
    }),
    vscode.commands.registerCommand("arp.openOverviewDraftComment", async (comment: Comment) => {
      await openCommentInEditor(comment);
    }),
    vscode.commands.registerCommand("arp.createDraftComment", async (reply: vscode.CommentReply) => {
      const comment = await reviewComments.createOrReply(reply);
      await reviewFiles.refresh();
      await reviewOverview.refresh();
      await reviewStatusBar.refresh();
      reviewCommentCodeLensProvider.refresh();
      if (comment) {
        await revealDraftCommentInOverview(reviewOverviewView, reviewOverview, comment);
        void vscode.window.showInformationMessage(formatAddedCommentMessage(comment));
      }
    }),
    vscode.commands.registerCommand("arp.editDraftComment", async (comment: DraftReviewComment) => {
      reviewComments.edit(comment);
    }),
    vscode.commands.registerCommand("arp.saveDraftComment", async (comment: DraftReviewComment) => {
      await reviewComments.save(comment);
      await reviewFiles.refresh();
      await reviewOverview.refresh();
      await reviewStatusBar.refresh();
      reviewCommentCodeLensProvider.refresh();
    }),
    vscode.commands.registerCommand("arp.cancelEditDraftComment", async (comment: DraftReviewComment) => {
      reviewComments.cancel(comment);
    }),
    vscode.commands.registerCommand("arp.deleteDraftComment", async (comment: DraftReviewComment) => {
      await reviewComments.delete(comment);
      await reviewFiles.refresh();
      await reviewOverview.refresh();
      await reviewStatusBar.refresh();
      reviewCommentCodeLensProvider.refresh();
    }),
    vscode.commands.registerCommand("arp.openReviewFileDiff", async (node: ReviewFileNode) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const { left, right } = createReviewDiffUris(workspaceRoot, node.file);
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${node.file.path} (ARP Review)`,
      );
    }),
    vscode.commands.registerCommand("arp.refreshReviewFiles", async () => {
      await reviewFiles.refresh();
    }),
    vscode.commands.registerCommand("arp.openNextReviewFile", async () => {
      const node = reviewFiles.getFirstPendingFile();
      if (!node) {
        void vscode.window.showWarningMessage("No review files available.");
        return;
      }

      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Open a workspace first.");
        return;
      }

      const { left, right } = createReviewDiffUris(workspaceRoot, node.file);
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${node.file.path} (ARP Review)`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.showOutput", async () => {
      outputChannel.show(true);
    }),
  );
}

async function initializeReviewUi(
  workspaceRoot: string | undefined,
  busDbPath: string | undefined,
  providers: {
    reviewComments: ReviewCommentsManager;
    reviewFiles: ReviewFilesProvider;
    reviewOverview: ReviewOverviewProvider;
    reviewStatusBar: ReviewStatusBar;
    reviewCommentCodeLensProvider: ReviewCommentCodeLensProvider;
  },
): Promise<void> {
  await providers.reviewComments.setWorkspaceRoot(workspaceRoot);
  await providers.reviewFiles.setWorkspaceRoot(workspaceRoot);
  await providers.reviewOverview.setWorkspaceRoot(workspaceRoot);
  await providers.reviewStatusBar.setWorkspaceRoot(workspaceRoot);
  providers.reviewCommentCodeLensProvider.setWorkspaceRoot(workspaceRoot);
  providers.reviewCommentCodeLensProvider.setHasActiveSession(false);
  providers.reviewComments.setHasActiveSession(false);

  if (!workspaceRoot) {
    return;
  }

  const hydrated = await hydrateReviewSessionState(workspaceRoot, busDbPath);
  providers.reviewCommentCodeLensProvider.setHasActiveSession(Boolean(hydrated.session));
  providers.reviewComments.setHasActiveSession(Boolean(hydrated.session));
  await providers.reviewComments.setLatestResult(hydrated.latestResult);
  await providers.reviewFiles.setLatestResult(hydrated.latestResult);
  await providers.reviewOverview.setLatestResult(hydrated.latestResult);
  await providers.reviewStatusBar.setLatestResult(hydrated.latestResult);
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getExtensionConfig(): {
  referenceServerCommand: string;
  referenceServerTimeoutMs: number;
  busDbPath: string;
  busWaitTimeoutMs: number;
  busPollIntervalMs: number;
  autoStartBusWorkerLoop: boolean;
  busWorkerLoopCommand: string;
  busWorkerLoopPollIntervalMs: number;
} {
  const config = vscode.workspace.getConfiguration("arp");

  return {
    referenceServerCommand: config.get<string>("referenceServerCommand", "arp-reference-server"),
    referenceServerTimeoutMs: config.get<number>("referenceServerTimeoutMs", 10000),
    busDbPath: config.get<string>("busDbPath", ""),
    busWaitTimeoutMs: config.get<number>("busWaitTimeoutMs", 15000),
    busPollIntervalMs: config.get<number>("busPollIntervalMs", 500),
    autoStartBusWorkerLoop: config.get<boolean>("autoStartBusWorkerLoop", true),
    busWorkerLoopCommand: config.get<string>("busWorkerLoopCommand", ""),
    busWorkerLoopPollIntervalMs: config.get<number>("busWorkerLoopPollIntervalMs", 1000),
  };
}

async function promptAndCreateDraftComment(
  workspaceRoot: string,
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<Comment | undefined> {
  const body = await vscode.window.showInputBox({
    prompt: "Draft review comment",
    placeHolder: "Explain the feedback for this change",
    ignoreFocusOut: true,
  });
  if (!body) {
    return undefined;
  }

  const category = (await vscode.window.showQuickPick(["note", "issue", "blocking"], {
    title: "Comment category",
    ignoreFocusOut: true,
  })) as CommentCategory | undefined;
  if (!category) {
    return undefined;
  }

  const relativePath = vscode.workspace.asRelativePath(uri);
  const artifact = await captureGitDiffArtifact(workspaceRoot);
  const selectedRange = normalizeCommentRange(uri, range);
  const isReviewRange = parseCommentingRangesFromPatch(artifact.patch, relativePath).some(
    (patchRange) =>
      selectedRange.start.line + 1 <= patchRange.endLine &&
      patchRange.startLine <= selectedRange.end.line + 1,
  );

  return await addDraftComment(workspaceRoot, {
    path: relativePath,
    side: "new",
    line: selectedRange.start.line + 1,
    startLine: selectedRange.start.line + 1,
    endLine: selectedRange.end.line + 1,
    body,
    category,
    scope: isReviewRange ? "review" : "context",
  });
}

function normalizeCommentRange(uri: vscode.Uri, fallbackRange: vscode.Range): vscode.Range {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri.toString()) {
    return fallbackRange;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    return fallbackRange;
  }

  return new vscode.Range(selection.start.line, 0, selection.end.line, 0);
}

async function revealDraftCommentInOverview(
  reviewOverviewView: vscode.TreeView<any>,
  reviewOverview: ReviewOverviewProvider,
  comment: Comment,
): Promise<void> {
  const node = reviewOverview.findDraftCommentNode(comment.id);
  if (!node) {
    return;
  }

  await reviewOverviewView.reveal(node, {
    select: true,
    focus: false,
    expand: 3,
  });
}

function formatAddedCommentMessage(comment: Comment): string {
  const scope = (comment.scope ?? "review") === "context" ? "Context reference" : "Review comment";
  const startLine = comment.startLine ?? comment.line ?? 1;
  const endLine = comment.endLine ?? comment.line ?? startLine;
  const location = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return `${scope} added on ${location}`;
}

async function openCommentInEditor(comment: Comment): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Open a workspace first.");
    return;
  }

  const uri = vscode.Uri.file(`${workspaceRoot}/${comment.path}`);
  const startLine = (comment.startLine ?? comment.line ?? 1) - 1;
  const endLine = (comment.endLine ?? comment.line ?? comment.startLine ?? 1) - 1;
  const selection = new vscode.Range(startLine, 0, endLine, 0);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preview: false,
    selection,
  });
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

function logLine(line: string): void {
  outputChannel.appendLine(line);
}

async function showReviewResult(
  response: any,
  changedFileCount: number | string,
  commentCount: number | string,
): Promise<void> {
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
