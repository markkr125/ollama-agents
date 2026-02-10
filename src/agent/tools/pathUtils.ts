import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Resolve a workspace-relative path to an absolute file system path.
 * Shared by all built-in tools that accept file/directory paths.
 */
export function resolveWorkspacePath(relativePath: string, workspace: vscode.WorkspaceFolder): string {
  return path.join(workspace.uri.fsPath, relativePath);
}
