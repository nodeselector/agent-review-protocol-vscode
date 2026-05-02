import * as vscode from "vscode";
import { sendJsonRpc } from "./rpc-client.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("arp.startSession", async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("No workspace folder open.");
        return;
      }

      const response = await sendJsonRpc("arp-reference-server", {
        jsonrpc: "2.0",
        id: 1,
        method: "session/create",
        params: { workspaceRoot },
      });

      void vscode.window.showInformationMessage(`ARP session started: ${JSON.stringify(response)}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("arp.submitStubReview", async () => {
      const editor = vscode.window.activeTextEditor;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!editor || !workspaceRoot) {
        void vscode.window.showErrorMessage("Open a file in a workspace first.");
        return;
      }

      const response = await sendJsonRpc("arp-pi-adapter", {
        jsonrpc: "2.0",
        id: 2,
        method: "review/submit",
        params: {
          sessionId: "sess_local",
          review: {
            event: "comment",
            summary: "Stub review from VS Code",
            comments: [
              {
                id: "c_1",
                path: vscode.workspace.asRelativePath(editor.document.uri),
                side: "new",
                line: editor.selection.active.line + 1,
                body: "Stub inline review comment",
                category: "note",
                status: "draft",
              },
            ],
          },
          artifact: {
            id: "art_local",
            type: "gitDiff",
            patch: "diff --git a/file b/file\n",
            changedFiles: [
              {
                path: vscode.workspace.asRelativePath(editor.document.uri),
                status: "modified",
              },
            ],
          },
        },
      });

      void vscode.window.showInformationMessage(`ARP stub review sent: ${JSON.stringify(response)}`);
    }),
  );
}

export function deactivate(): void {}
