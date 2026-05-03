import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import * as vscode from "vscode";
import { getRelativePathFromReviewUri, parseReviewDocumentQuery, REVIEW_SCHEME_NAME } from "./review-files.js";

const execFileAsync = promisify(execFile);

export class ReviewFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  watch(): vscode.Disposable {
    return { dispose: () => {} };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.readFileContent(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: new TextEncoder().encode(content).length,
    };
  }

  readDirectory(): Thenable<[string, vscode.FileType][]> {
    return Promise.resolve([]);
  }

  createDirectory(): void {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const content = await this.readFileContent(uri);
    return new TextEncoder().encode(content);
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions("ARP review files are read-only");
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("ARP review files are read-only");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("ARP review files are read-only");
  }

  private async readFileContent(uri: vscode.Uri): Promise<string> {
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
