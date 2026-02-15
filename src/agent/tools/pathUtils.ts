import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Resolve a workspace-relative path to an absolute file system path.
 * If the path is already absolute, return it as-is.
 * Shared by all built-in tools that accept file/directory paths.
 */
export function resolveWorkspacePath(relativePath: string, workspace: vscode.WorkspaceFolder): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(workspace.uri.fsPath, relativePath);
}
