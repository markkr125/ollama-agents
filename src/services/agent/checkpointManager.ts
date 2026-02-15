import { structuredPatch } from 'diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { PendingEditDecorationProvider } from '../pendingEditDecorationProvider';

// ---------------------------------------------------------------------------
// CheckpointManager — file snapshot, keep/undo, and diff operations for
// agent checkpoints. Extracted from AgentChatExecutor.
// ---------------------------------------------------------------------------

export class CheckpointManager {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly editManager: EditManager,
    private readonly decorationProvider: PendingEditDecorationProvider,
    private readonly refreshExplorer: () => void,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * Record a pre-edit snapshot of a file before the agent modifies it.
   */
  async snapshotFileBeforeEdit(
    args: any,
    context: any,
    checkpointId: string
  ): Promise<void> {
    try {
      const relPath = String(args?.path || args?.file || '').trim();
      if (!relPath) return;

      const workspaceRoot = context.workspace?.uri?.fsPath || '';
      const absPath = path.join(workspaceRoot, relPath);
      const uri = vscode.Uri.file(absPath);

      let originalContent: string | null = null;
      let action = 'modified';

      try {
        const existing = await vscode.workspace.fs.readFile(uri);
        originalContent = new TextDecoder().decode(existing);
      } catch {
        originalContent = null;
        action = 'created';
      }

      await this.databaseService.insertFileSnapshot(checkpointId, relPath, originalContent, action);
    } catch (err) {
      console.warn('[CheckpointManager] Failed to snapshot file before edit:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Diff views
  // -------------------------------------------------------------------------

  /**
   * Open a diff view for a file from a checkpoint snapshot.
   */
  async openFileChangeDiff(checkpointId: string, filePath: string): Promise<void> {
    const snapshot = await this.databaseService.getSnapshotForFile(checkpointId, filePath);
    if (!snapshot) {
      vscode.window.showWarningMessage(`No snapshot found for ${filePath}`);
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const absPath = path.join(workspaceRoot, filePath);
    const fileUri = vscode.Uri.file(absPath);

    const originalContent = snapshot.original_content ?? '';
    await this.editManager.showDiff(
      fileUri,
      originalContent,
      undefined as any, // Will read current file content
      `AI changes: ${filePath}`
    );
  }

  /**
   * Open a diff between the snapshot's original_content and the current file
   * on disk.
   */
  async openSnapshotDiff(
    checkpointId: string | undefined,
    filePath: string,
    sessionId?: string
  ): Promise<void> {
    let snapshot = checkpointId
      ? await this.databaseService.getSnapshotForFile(checkpointId, filePath)
      : null;

    // Fallback: search session checkpoints for this file if direct lookup failed
    if (!snapshot && sessionId) {
      const checkpoints = await this.databaseService.getCheckpoints(sessionId);
      for (const cp of checkpoints) {
        snapshot = await this.databaseService.getSnapshotForFile(cp.id, filePath);
        if (snapshot) break;
      }
    }

    if (!snapshot) {
      vscode.window.showWarningMessage(`No snapshot found for ${filePath}`);
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const absPath = path.join(workspaceRoot, filePath);
    const currentUri = vscode.Uri.file(absPath);

    const originalContent = snapshot.original_content ?? '';
    let currentContent = '';
    try {
      const data = await vscode.workspace.fs.readFile(currentUri);
      currentContent = new TextDecoder().decode(data);
    } catch {
      currentContent = '';
    }

    await this.editManager.showDiff(
      currentUri,
      originalContent,
      currentContent,
      `AI changes: ${filePath}`
    );
  }

  // -------------------------------------------------------------------------
  // Keep / Undo individual files
  // -------------------------------------------------------------------------

  /**
   * Keep a single file's changes (mark as accepted).
   */
  async keepFile(checkpointId: string, filePath: string): Promise<{ success: boolean }> {
    await this.databaseService.updateFileSnapshotStatus(checkpointId, filePath, 'kept');

    const workspaceRoot = this.getWorkspaceRoot();
    const absPath = path.join(workspaceRoot, filePath);
    this.decorationProvider.clearPending(vscode.Uri.file(absPath));

    await this.updateCheckpointStatusFromFiles(checkpointId);
    return { success: true };
  }

  /**
   * Undo a single file's changes (revert to original).
   */
  async undoFile(checkpointId: string, filePath: string): Promise<{ success: boolean }> {
    const snapshot = await this.databaseService.getSnapshotForFile(checkpointId, filePath);
    if (!snapshot) {
      return { success: false };
    }

    // For created files, original_content is null — undo means delete the file.
    // For modified files, original_content must be present to revert.
    if (snapshot.action !== 'created' && snapshot.original_content === null) {
      return { success: false };
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const absPath = path.join(workspaceRoot, filePath);
    const uri = vscode.Uri.file(absPath);

    try {
      if (snapshot.action === 'created') {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } else {
        const edit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(uri, fullRange, snapshot.original_content!);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
      }
    } catch (err: any) {
      console.warn(`[CheckpointManager] Failed to revert ${filePath}:`, err);
      return { success: false };
    }

    await this.databaseService.updateFileSnapshotStatus(checkpointId, filePath, 'undone');
    this.decorationProvider.clearPending(uri);
    this.refreshExplorer();

    await this.updateCheckpointStatusFromFiles(checkpointId);
    return { success: true };
  }

  /**
   * Mark a file as undone in the DB + clear decoration, WITHOUT reverting
   * file content. Used by the inline review service which already reverted
   * the file on disk.
   */
  async markFileUndone(checkpointId: string, filePath: string): Promise<void> {
    await this.databaseService.updateFileSnapshotStatus(checkpointId, filePath, 'undone');

    const workspaceRoot = this.getWorkspaceRoot();
    const absPath = path.join(workspaceRoot, filePath);
    this.decorationProvider.clearPending(vscode.Uri.file(absPath));

    await this.updateCheckpointStatusFromFiles(checkpointId);
  }

  // -------------------------------------------------------------------------
  // Keep / Undo all files
  // -------------------------------------------------------------------------

  /**
   * Keep all file changes in a checkpoint.
   */
  async keepAllChanges(checkpointId: string): Promise<{ success: boolean }> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const workspaceRoot = this.getWorkspaceRoot();

    for (const snap of snapshots) {
      if (snap.file_status === 'pending') {
        await this.databaseService.updateFileSnapshotStatus(checkpointId, snap.file_path, 'kept');
        const absPath = path.join(workspaceRoot, snap.file_path);
        this.decorationProvider.clearPending(vscode.Uri.file(absPath));
      }
    }
    await this.databaseService.updateCheckpointStatus(checkpointId, 'kept');
    // Prune original_content blobs to free storage
    await this.databaseService.pruneKeptCheckpointContent(checkpointId);
    return { success: true };
  }

  /**
   * Undo all file changes in a checkpoint.
   */
  async undoAllChanges(checkpointId: string): Promise<{ success: boolean; errors: string[] }> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const workspaceRoot = this.getWorkspaceRoot();
    const errors: string[] = [];

    const edit = new vscode.WorkspaceEdit();
    const filesToDelete: vscode.Uri[] = [];

    for (const snap of snapshots) {
      if (snap.file_status !== 'pending') continue;
      if (snap.original_content === null) continue;

      const absPath = path.join(workspaceRoot, snap.file_path);
      const uri = vscode.Uri.file(absPath);

      try {
        if (snap.action === 'created') {
          filesToDelete.push(uri);
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );
          edit.replace(uri, fullRange, snap.original_content);
        }
      } catch (err: any) {
        errors.push(`${snap.file_path}: ${err.message}`);
      }
    }

    const editSuccess = await vscode.workspace.applyEdit(edit);
    if (!editSuccess) {
      errors.push('WorkspaceEdit.applyEdit failed');
    }

    for (const uri of filesToDelete) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch (err: any) {
        errors.push(`Delete ${uri.fsPath}: ${err.message}`);
      }
    }

    // Save all modified documents
    for (const snap of snapshots) {
      if (snap.file_status !== 'pending' || snap.action === 'created') continue;
      try {
        const absPath = path.join(workspaceRoot, snap.file_path);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
        if (doc?.isDirty) await doc.save();
      } catch { /* best effort */ }
    }

    // Update all statuses
    for (const snap of snapshots) {
      if (snap.file_status === 'pending') {
        await this.databaseService.updateFileSnapshotStatus(checkpointId, snap.file_path, 'undone');
        const absPath = path.join(workspaceRoot, snap.file_path);
        this.decorationProvider.clearPending(vscode.Uri.file(absPath));
      }
    }

    await this.databaseService.updateCheckpointStatus(checkpointId, 'undone');
    this.refreshExplorer();
    return { success: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // Diff stats
  // -------------------------------------------------------------------------

  /**
   * Compute diff stats for all files in a checkpoint (original vs current on
   * disk).
   */
  async computeFilesDiffStats(
    checkpointId: string
  ): Promise<Array<{ path: string; additions: number; deletions: number; action: string }>> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const workspaceRoot = this.getWorkspaceRoot();
    const results: Array<{ path: string; additions: number; deletions: number; action: string }> = [];

    for (const snap of snapshots) {
      const absPath = path.join(workspaceRoot, snap.file_path);
      let currentContent = '';
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        currentContent = new TextDecoder().decode(data);
      } catch {
        currentContent = '';
      }

      const original = snap.original_content ?? '';
      let additions = 0;
      let deletions = 0;

      const patch = structuredPatch('a', 'b', original, currentContent, '', '', { context: 0 });
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) additions++;
          else if (line.startsWith('-')) deletions++;
        }
      }

      results.push({
        path: snap.file_path,
        additions,
        deletions,
        action: snap.action
      });
    }

    // Persist per-file diff stats for accurate session-level totals
    await this.databaseService.updateFileSnapshotsDiffStats(checkpointId, results);

    // Cache aggregate stats on the checkpoint for fast session list queries
    const totalAdd = results.reduce((s, r) => s + r.additions, 0);
    const totalDel = results.reduce((s, r) => s + r.deletions, 0);
    await this.databaseService.updateCheckpointDiffStats(checkpointId, totalAdd, totalDel);

    return results;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Update the checkpoint status based on the aggregate file statuses.
   */
  private async updateCheckpointStatusFromFiles(checkpointId: string): Promise<void> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const statuses = new Set(snapshots.map(s => s.file_status));

    let newStatus: string;
    if (statuses.size === 1) {
      newStatus = statuses.has('kept') ? 'kept' : statuses.has('undone') ? 'undone' : 'pending';
    } else if (statuses.has('pending')) {
      newStatus = 'partial';
    } else {
      newStatus = 'partial';
    }

    await this.databaseService.updateCheckpointStatus(checkpointId, newStatus);
  }

  /**
   * Open the multi-diff editor showing all pending file changes across the
   * given checkpoints. Uses the `ollama-original:` URI scheme (registered
   * globally in extension.ts) for the "before" side and the on-disk file
   * for the "after" side.
   */
  async openAllEdits(checkpointIds: string[]): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    const changes: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    const seen = new Set<string>();

    for (const cpId of checkpointIds) {
      const snapshots = await this.databaseService.getFileSnapshots(cpId);
      for (const snap of snapshots) {
        if (snap.file_status !== 'pending' || seen.has(snap.file_path)) continue;
        seen.add(snap.file_path);

        const absPath = path.join(workspaceRoot, snap.file_path);
        const fileUri = vscode.Uri.file(absPath);
        const originalUri = vscode.Uri.from({
          scheme: 'ollama-original',
          path: absPath,
          query: `ckpt=${encodeURIComponent(cpId)}&rel=${encodeURIComponent(snap.file_path)}`
        });
        changes.push([fileUri, originalUri, fileUri]);
      }
    }

    if (changes.length === 0) {
      vscode.window.showInformationMessage('No pending changes to review.');
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.changes',
      `Suggested Edits (${changes.length} file${changes.length !== 1 ? 's' : ''})`,
      changes
    );
  }

  private getWorkspaceRoot(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    return workspaceFolders?.[0]?.uri.fsPath || '';
  }
}
