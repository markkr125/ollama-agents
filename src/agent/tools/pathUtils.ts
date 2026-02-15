import * as fs from 'fs';
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

/**
 * Resolve a relative path across multiple workspace folders (multi-root support).
 *
 * Resolution order:
 * 1. Absolute paths → returned as-is.
 * 2. Try `primaryWorkspace/relativePath` — use if file exists.
 * 3. Try each additional workspace folder — use if file exists.
 * 4. Try interpreting the first path segment as a workspace folder **name**
 *    (e.g. `backend/src/app.ts` where "backend" is a folder name).
 * 5. Fall back to `primaryWorkspace/relativePath` (for new-file writes).
 *
 * If `allFolders` is `undefined` or has ≤ 1 entry, behaves identically to
 * `resolveWorkspacePath`.
 */
export function resolveMultiRootPath(
  relativePath: string,
  primaryWorkspace: vscode.WorkspaceFolder,
  allFolders?: readonly vscode.WorkspaceFolder[]
): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }

  // Single-root fast path
  if (!allFolders || allFolders.length <= 1) {
    // Strip workspace folder name prefix if present.
    // vscode.workspace.asRelativePath(path, true) prepends the folder name
    // (e.g. "demo-project/rss-fetch.ts" for a workspace at …/demo-project/).
    // Without stripping, path.join would double it: …/demo-project/demo-project/rss-fetch.ts
    // Only strip when the prefixed path doesn't exist but the stripped one does,
    // to avoid breaking a real subdirectory that shares the folder name.
    const folderName = primaryWorkspace.name;
    if (relativePath.startsWith(folderName + '/') || relativePath.startsWith(folderName + path.sep)) {
      const withPrefix = path.join(primaryWorkspace.uri.fsPath, relativePath);
      const stripped = path.join(primaryWorkspace.uri.fsPath, relativePath.slice(folderName.length + 1));
      if (!fs.existsSync(withPrefix) && fs.existsSync(stripped)) {
        return stripped;
      }
    }
    return path.join(primaryWorkspace.uri.fsPath, relativePath);
  }

  // Try primary workspace first
  const primaryPath = path.join(primaryWorkspace.uri.fsPath, relativePath);
  if (fs.existsSync(primaryPath)) {
    return primaryPath;
  }

  // Try every other workspace folder
  for (const folder of allFolders) {
    if (folder.uri.fsPath === primaryWorkspace.uri.fsPath) continue;
    const candidate = path.join(folder.uri.fsPath, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Try interpreting the first path segment as a folder name.
  // In multi-root workspaces, `vscode.workspace.asRelativePath()` returns
  // `folderName/relative/path`, so LLMs may produce paths in that format.
  const segments = relativePath.split(/[/\\]/);
  if (segments.length > 1) {
    const folderName = segments[0];
    const rest = segments.slice(1).join(path.sep);
    for (const folder of allFolders) {
      if (folder.name === folderName) {
        const candidate = path.join(folder.uri.fsPath, rest);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  // Nothing found — default to primary workspace (safe for writes)
  return primaryPath;
}
