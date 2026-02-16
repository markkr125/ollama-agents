import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Stable storage path resolution
//
// VS Code's `context.storageUri` is derived from a hash of the workspace
// identity. When the user adds a second folder (converting single-root to
// multi-root), VS Code silently creates a **new** workspace identity →
// `storageUri` points to a completely different (empty) directory → all
// existing sessions appear "erased."
//
// This module fixes the problem by computing a **stable** storage path:
//
//   1. If the user has set `ollamaCopilot.storagePath` → use that literally.
//   2. Otherwise → `globalStorageUri/<sha256(firstFolderUri)>/`
//      The first workspace folder's URI is stable across single→multi-root
//      conversions (adding a folder does NOT change folders[0]).
//   3. If no workspace folder is open → fall back to `globalStorageUri`.
//
// On first activation under the new scheme, `migrateIfNeeded()` copies the
// databases from the old `context.storageUri` path to the new location.
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic hex key from a workspace folder URI.
 * Using the full URI string (including scheme) avoids collisions between
 * identically-named folders at different paths.
 */
export function workspaceKey(folderUri: vscode.Uri): string {
  return createHash('sha256')
    .update(folderUri.toString())
    .digest('hex');
}

/**
 * Resolve the stable storage directory URI for the extension's databases.
 *
 * Priority:
 *   1. `ollamaCopilot.storagePath` setting (absolute path)
 *   2. `globalStorageUri/<sha256(workspaceFolders[0].uri)>/`
 *   3. `globalStorageUri` (no workspace open)
 */
export function resolveStoragePath(context: vscode.ExtensionContext): vscode.Uri {
  // 1. User-configured override
  const customPath = vscode.workspace
    .getConfiguration('ollamaCopilot')
    .get<string>('storagePath', '')
    .trim();

  if (customPath) {
    return vscode.Uri.file(customPath);
  }

  const globalUri = context.globalStorageUri;

  // 2. Workspace-keyed subdirectory under globalStorageUri
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const key = workspaceKey(folders[0].uri);
    return vscode.Uri.joinPath(globalUri, key);
  }

  // 3. No workspace — use globalStorageUri directly
  return globalUri;
}

// ---------------------------------------------------------------------------
// Silent migration from old context.storageUri → new stable path
// ---------------------------------------------------------------------------

const SQLITE_FILE = 'sessions.sqlite';
const LANCEDB_DIR = 'ollama-copilot.lance';

/**
 * If the new storage directory is empty but the old `context.storageUri` has
 * databases, copy them over silently. This handles the one-time transition.
 *
 * Does nothing if:
 * - `context.storageUri` is undefined (no workspace open → nothing to migrate)
 * - The new location already has a `sessions.sqlite` (already migrated)
 * - The old location has no `sessions.sqlite` (nothing to migrate)
 * - The old and new paths are identical (no migration needed)
 */
export async function migrateIfNeeded(
  context: vscode.ExtensionContext,
  newStorageUri: vscode.Uri
): Promise<void> {
  const oldStorageUri = context.storageUri;
  if (!oldStorageUri) return;

  // If old and new are the same directory, nothing to do
  if (oldStorageUri.fsPath === newStorageUri.fsPath) return;

  const oldSqlite = path.join(oldStorageUri.fsPath, SQLITE_FILE);
  const newSqlite = path.join(newStorageUri.fsPath, SQLITE_FILE);

  try {
    // Skip if new location already has a database (already migrated or fresh)
    if (fs.existsSync(newSqlite)) return;

    // Skip if old location has no database (nothing to migrate)
    if (!fs.existsSync(oldSqlite)) return;

    // Ensure target directory exists
    fs.mkdirSync(newStorageUri.fsPath, { recursive: true });

    // Copy SQLite database
    fs.copyFileSync(oldSqlite, newSqlite);

    // Copy SQLite WAL and SHM files if they exist
    for (const suffix of ['-wal', '-shm']) {
      const oldWal = oldSqlite + suffix;
      if (fs.existsSync(oldWal)) {
        fs.copyFileSync(oldWal, newSqlite + suffix);
      }
    }

    // Copy LanceDB directory if it exists
    const oldLance = path.join(oldStorageUri.fsPath, LANCEDB_DIR);
    const newLance = path.join(newStorageUri.fsPath, LANCEDB_DIR);
    if (fs.existsSync(oldLance) && !fs.existsSync(newLance)) {
      copyDirSync(oldLance, newLance);
    }

    console.log(
      `[OllamaCopilot] Migrated databases from ${oldStorageUri.fsPath} → ${newStorageUri.fsPath}`
    );
  } catch (err) {
    // Migration failure is non-fatal — log and continue with empty DB
    console.error('[OllamaCopilot] Database migration failed (non-fatal):', err);
  }
}

/**
 * Recursively copy a directory tree (sync).
 * Node 16.7+ has `fs.cpSync` but VS Code's min Node target may not have it,
 * so we do it manually.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
