import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Synchronously search for a file by bare filename across workspace folders.
 * Uses a breadth-first walk (max depth 8) over src-like directories first,
 * then falls back to the full tree. Returns the first match found, or null.
 *
 * This is intentionally synchronous and limited to prevent slowdowns on
 * large workspaces. The max-depth cap avoids crawling node_modules/dist/etc.
 */
function findFileByName(filename: string, folders: readonly vscode.WorkspaceFolder[]): string | null {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv']);
  const MAX_DEPTH = 8;

  function walk(dir: string, depth: number): string | null {
    if (depth > MAX_DEPTH) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Check files at this level first
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) {
        return path.join(dir, entry.name);
      }
    }
    // Then recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        const found = walk(path.join(dir, entry.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  for (const folder of folders) {
    const found = walk(folder.uri.fsPath, 0);
    if (found) return found;
  }
  return null;
}

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
    const folderName = primaryWorkspace.name;
    // Exact folder name match — resolve to the workspace root, not root/root.
    // LLMs sometimes pass just the folder name (e.g. list_files(path="myproject")).
    if (relativePath === folderName) {
      return primaryWorkspace.uri.fsPath;
    }
    // Strip workspace folder name prefix if present.
    // vscode.workspace.asRelativePath(path, true) prepends the folder name
    // (e.g. "demo-project/rss-fetch.ts" for a workspace at …/demo-project/).
    // Without stripping, path.join would double it: …/demo-project/demo-project/rss-fetch.ts
    // Only strip when the prefixed path doesn't exist but the stripped one does,
    // to avoid breaking a real subdirectory that shares the folder name.
    if (relativePath.startsWith(folderName + '/') || relativePath.startsWith(folderName + path.sep)) {
      const withPrefix = path.join(primaryWorkspace.uri.fsPath, relativePath);
      const stripped = path.join(primaryWorkspace.uri.fsPath, relativePath.slice(folderName.length + 1));
      if (!fs.existsSync(withPrefix) && fs.existsSync(stripped)) {
        return stripped;
      }
    }
    const resolved = path.join(primaryWorkspace.uri.fsPath, relativePath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    // Bare filename fallback — search the workspace tree when a simple
    // filename like "ProcessSearch.ts" doesn't resolve directly.
    const isBareFilename = !relativePath.includes('/') && !relativePath.includes(path.sep) && relativePath.includes('.');
    if (isBareFilename) {
      const found = findFileByName(relativePath, [primaryWorkspace]);
      if (found) {
        return found;
      }
    }
    return resolved;
  }

  // If the entire relativePath matches a workspace folder name (no path separators),
  // resolve directly to that folder's root. This prevents list_files("backend")
  // from resolving to primaryWorkspace/backend (doubled) or accidentally matching
  // a subdirectory in another workspace folder.
  if (!relativePath.includes('/') && !relativePath.includes(path.sep)) {
    for (const folder of allFolders) {
      if (folder.name === relativePath) {
        return folder.uri.fsPath;
      }
    }
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

  // Bare filename fallback — LLMs (especially smaller models) often pass
  // just the filename without the directory path (e.g. "ProcessSearch.ts"
  // instead of "src/helpers/Search/ProcessSearch.ts"). Use VS Code's
  // findFiles API to locate the file anywhere in the workspace.
  const isBareFilename = !relativePath.includes('/') && !relativePath.includes(path.sep) && relativePath.includes('.');
  if (isBareFilename) {
    const found = findFileByName(relativePath, allFolders);
    if (found) {
      return found;
    }
  }

  // Nothing found — default to primary workspace (safe for writes)
  return primaryPath;
}
