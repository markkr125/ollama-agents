import { structuredPatch } from 'diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from './databaseService';

/**
 * A single contiguous hunk of changes in a file.
 */
interface ReviewHunk {
  /** 0-based start line of the hunk in the NEW (current) file */
  startLine: number;
  /** 0-based end line (inclusive) of added lines — same as startLine when pure deletion */
  endLine: number;
  /** 0-based line numbers of added lines in the current file */
  addedLines: number[];
  /** How many lines were deleted from the original */
  deletedCount: number;
  /** The original text that was replaced (for undo) — empty string for pure additions */
  originalText: string;
  /** The new text that replaced it — empty string for pure deletions */
  newText: string;
}

/**
 * Per-file review state.
 */
interface FileReviewState {
  uri: vscode.Uri;
  checkpointId: string;
  filePath: string;          // relative path
  hunks: ReviewHunk[];
  addedDecoration: vscode.TextEditorDecorationType;
  deletedDecoration: vscode.TextEditorDecorationType;
  /** Index of the hunk currently focused */
  currentHunkIndex: number;
}

/**
 * Tracks the full review session (all files in a checkpoint).
 */
interface ReviewSession {
  checkpointId: string;
  files: FileReviewState[];
  currentFileIndex: number;
}

/**
 * Emitted when a file has all its hunks resolved during inline review.
 */
export interface FileReviewResolvedEvent {
  checkpointId: string;
  filePath: string;
  /** 'kept' = file still differs from original, 'undone' = file matches original */
  action: 'kept' | 'undone';
}

/**
 * Emitted when a hunk is kept/undone so the widget can update per-file stats.
 */
export interface FileHunkStatsEvent {
  checkpointId: string;
  filePath: string;
  additions: number;
  deletions: number;
}

/**
 * PendingEditReviewService — opens files with inline change decorations
 * (green for added, red gutter for deleted) and provides hunk-level
 * navigation + keep/undo via CodeLens and editor title bar icons.
 */
export class PendingEditReviewService implements vscode.Disposable {
  private activeSession: ReviewSession | null = null;
  private disposables: vscode.Disposable[] = [];

  // CodeLens
  private codeLensProvider: ReviewCodeLensProvider;
  private codeLensDisposable: vscode.Disposable | null = null;

  // Event: fires whenever review state changes (for external consumers)
  private _onDidChangeReviewState = new vscode.EventEmitter<void>();
  readonly onDidChangeReviewState = this._onDidChangeReviewState.event;

  // Event: fires when all hunks in a file are resolved
  private _onDidResolveFile = new vscode.EventEmitter<FileReviewResolvedEvent>();
  readonly onDidResolveFile = this._onDidResolveFile.event;

  // Event: fires when a hunk is resolved (for widget stats sync)
  private _onDidUpdateHunkStats = new vscode.EventEmitter<FileHunkStatsEvent>();
  readonly onDidUpdateHunkStats = this._onDidUpdateHunkStats.event;

  constructor(private readonly databaseService: DatabaseService) {
    this.codeLensProvider = new ReviewCodeLensProvider(this);

    // Track active editor changes to re-apply decorations
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && this.activeSession) {
          this.applyDecorationsForEditor(editor);
        }
      })
    );
  }

  /** Get current review session (for CodeLens provider). */
  getActiveSession(): ReviewSession | null {
    return this.activeSession;
  }

  /** Get the FileReviewState for a given URI, if any. */
  getFileState(uri: vscode.Uri): FileReviewState | undefined {
    return this.activeSession?.files.find(f => f.uri.toString() === uri.toString());
  }

  // ---------------------------------------------------------------------------
  // Public API — called from agentChatExecutor
  // ---------------------------------------------------------------------------

  /**
   * Open a file with inline change decorations.
   * If a review session already exists for this checkpoint, just navigate.
   * Otherwise create a new review session.
   */
  async openFileReview(
    checkpointId: string,
    filePath: string,
    sessionId?: string
  ): Promise<void> {
    // Resolve checkpoint if needed (same fallback as openSnapshotDiff)
    let resolvedCheckpointId = checkpointId;
    if (!resolvedCheckpointId && sessionId) {
      const checkpoints = await this.databaseService.getCheckpoints(sessionId);
      for (const cp of checkpoints) {
        const snap = await this.databaseService.getSnapshotForFile(cp.id, filePath);
        if (snap) {
          resolvedCheckpointId = cp.id;
          break;
        }
      }
    }

    if (!resolvedCheckpointId) {
      vscode.window.showWarningMessage(`No snapshot found for ${filePath}`);
      return;
    }

    // Build or reuse session
    if (!this.activeSession || this.activeSession.checkpointId !== resolvedCheckpointId) {
      await this.buildReviewSession(resolvedCheckpointId);
    }

    if (!this.activeSession) return;

    // Find the file in session and navigate to it
    const idx = this.activeSession.files.findIndex(f => f.filePath === filePath);
    if (idx < 0) {
      vscode.window.showWarningMessage(`File ${filePath} not found in review session`);
      return;
    }

    this.activeSession.currentFileIndex = idx;
    await this.openAndDecorateFile(idx);
  }

  /**
   * Navigate to prev/next file in the review session.
   */
  async navigateFile(direction: 'prev' | 'next'): Promise<void> {
    if (!this.activeSession || this.activeSession.files.length === 0) return;

    if (direction === 'next') {
      this.activeSession.currentFileIndex =
        (this.activeSession.currentFileIndex + 1) % this.activeSession.files.length;
    } else {
      this.activeSession.currentFileIndex =
        (this.activeSession.currentFileIndex - 1 + this.activeSession.files.length) % this.activeSession.files.length;
    }

    await this.openAndDecorateFile(this.activeSession.currentFileIndex);
  }

  /**
   * Navigate to prev/next hunk within the current file.
   */
  navigateHunk(direction: 'prev' | 'next'): void {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;

    if (direction === 'next') {
      fileState.currentHunkIndex = (fileState.currentHunkIndex + 1) % fileState.hunks.length;
    } else {
      fileState.currentHunkIndex = (fileState.currentHunkIndex - 1 + fileState.hunks.length) % fileState.hunks.length;
    }

    this.scrollToHunk(fileState);
  }

  /**
   * Remove a file from the active review session (e.g., when the widget's
   * keep/undo resolves it externally). Cleans up decorations and CodeLens.
   * Does NOT emit onDidResolveFile (caller is responsible for DB + widget updates).
   */
  removeFileFromReview(filePath: string): void {
    if (!this.activeSession) return;

    const idx = this.activeSession.files.findIndex(f => f.filePath === filePath);
    if (idx < 0) return;

    const fileState = this.activeSession.files[idx];
    fileState.addedDecoration.dispose();
    fileState.deletedDecoration.dispose();
    this.activeSession.files.splice(idx, 1);

    if (this.activeSession.currentFileIndex >= this.activeSession.files.length) {
      this.activeSession.currentFileIndex = Math.max(0, this.activeSession.files.length - 1);
    }

    if (this.activeSession.files.length === 0) {
      this.closeReview();
    } else {
      this.codeLensProvider.refresh();
    }
  }

  /**
   * Close the review session and clean up decorations + status bar.
   */
  closeReview(): void {
    if (!this.activeSession) return;

    for (const fileState of this.activeSession.files) {
      fileState.addedDecoration.dispose();
      fileState.deletedDecoration.dispose();
    }

    if (this.codeLensDisposable) {
      this.codeLensDisposable.dispose();
      this.codeLensDisposable = null;
    }

    this.activeSession = null;
    vscode.commands.executeCommand('setContext', 'ollamaCopilot.reviewActive', false);
    this._onDidChangeReviewState.fire();
  }

  /**
   * Keep a hunk — accept the AI change (just stop highlighting it).
   */
  keepHunk(filePath: string, hunkIndex: number): void {
    const fileState = this.findFileByPath(filePath);
    if (!fileState || hunkIndex < 0 || hunkIndex >= fileState.hunks.length) return;

    // Remove the hunk from tracking
    fileState.hunks.splice(hunkIndex, 1);

    // Adjust currentHunkIndex
    if (fileState.hunks.length === 0) {
      fileState.currentHunkIndex = 0;
    } else if (fileState.currentHunkIndex >= fileState.hunks.length) {
      fileState.currentHunkIndex = fileState.hunks.length - 1;
    }

    this.refreshDecorationsForFile(fileState);
    this.emitHunkStats(fileState);
    this.checkFileFullyReviewed(fileState);
  }

  /**
   * Undo a hunk — revert the AI change for this hunk to original text.
   */
  async undoHunk(filePath: string, hunkIndex: number): Promise<void> {
    const fileState = this.findFileByPath(filePath);
    if (!fileState || hunkIndex < 0 || hunkIndex >= fileState.hunks.length) return;

    const hunk = fileState.hunks[hunkIndex];
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== fileState.uri.toString()) return;

    const doc = editor.document;

    const success = await editor.edit(editBuilder => {
      if (hunk.addedLines.length > 0 && !hunk.originalText) {
        // ── Pure addition: delete the added lines entirely ──
        const firstLine = hunk.addedLines[0];
        const lastLine = hunk.addedLines[hunk.addedLines.length - 1];

        if (lastLine + 1 < doc.lineCount) {
          // Delete from BOL of first added to BOL of next line (consumes trailing \n)
          editBuilder.delete(new vscode.Range(firstLine, 0, lastLine + 1, 0));
        } else if (firstLine > 0) {
          // Added lines at end of file — eat the preceding \n too
          const prevEnd = doc.lineAt(firstLine - 1).range.end;
          const lastEnd = doc.lineAt(lastLine).range.end;
          editBuilder.delete(new vscode.Range(prevEnd, lastEnd));
        } else {
          // Entire file is the addition — clear everything
          const lastEnd = doc.lineAt(lastLine).range.end;
          editBuilder.delete(new vscode.Range(0, 0, lastEnd.line, lastEnd.character));
        }
      } else if (hunk.addedLines.length > 0 && hunk.originalText) {
        // ── Replacement: swap added lines with original text ──
        const firstLine = hunk.addedLines[0];
        const lastLine = hunk.addedLines[hunk.addedLines.length - 1];

        if (lastLine + 1 < doc.lineCount) {
          editBuilder.replace(
            new vscode.Range(firstLine, 0, lastLine + 1, 0),
            hunk.originalText + '\n'
          );
        } else {
          editBuilder.replace(
            new vscode.Range(firstLine, 0, lastLine, doc.lineAt(lastLine).text.length),
            hunk.originalText
          );
        }
      } else if (hunk.deletedCount > 0 && hunk.addedLines.length === 0) {
        // ── Pure deletion: re-insert original text at the deletion point ──
        editBuilder.insert(
          new vscode.Position(hunk.startLine, 0),
          hunk.originalText + '\n'
        );
      }
    });

    if (!success) return;

    // Save the file so the on-disk content is up to date
    await editor.document.save();

    // Calculate the line delta caused by this undo so we can shift remaining hunks.
    // We DON'T recompute hunks from scratch — that would change the boundaries
    // of other hunks and confuse the user.
    const addedLineCount = hunk.addedLines.length;
    const originalLineCount = hunk.originalText ? hunk.originalText.split('\n').length : 0;
    // Lines before undo: addedLineCount lines occupied this region.
    // Lines after undo: originalLineCount lines (or 0 for pure additions that deleted all).
    const delta = originalLineCount - addedLineCount;

    // Remove the undone hunk from the list
    fileState.hunks.splice(hunkIndex, 1);

    // Shift all subsequent hunks by delta
    for (let i = hunkIndex; i < fileState.hunks.length; i++) {
      const h = fileState.hunks[i];
      h.startLine += delta;
      h.endLine += delta;
      h.addedLines = h.addedLines.map(l => l + delta);
    }

    // Adjust currentHunkIndex
    if (fileState.hunks.length === 0) {
      fileState.currentHunkIndex = 0;
    } else {
      fileState.currentHunkIndex = Math.min(hunkIndex, fileState.hunks.length - 1);
    }

    this.refreshDecorationsForFile(fileState);
    this.emitHunkStats(fileState);
    this.checkFileFullyReviewed(fileState);
  }

  /**
   * Keep the currently focused hunk (for status bar button — no arguments).
   */
  keepCurrentHunk(): void {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;
    this.keepHunk(fileState.filePath, fileState.currentHunkIndex);
  }

  /**
   * Undo the currently focused hunk (for status bar button — no arguments).
   */
  async undoCurrentHunk(): Promise<void> {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;
    await this.undoHunk(fileState.filePath, fileState.currentHunkIndex);
  }

  // ---------------------------------------------------------------------------
  // Hunk helper methods
  // ---------------------------------------------------------------------------

  private findFileByPath(filePath: string): FileReviewState | undefined {
    return this.activeSession?.files.find(f => f.filePath === filePath);
  }

  private refreshDecorationsForFile(fileState: FileReviewState): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === fileState.uri.toString()) {
      this.applyDecorations(editor, fileState);
    }
    this.codeLensProvider.refresh();
  }

  /** Compute remaining additions/deletions from hunks and fire event. */
  private emitHunkStats(fileState: FileReviewState): void {
    let additions = 0;
    let deletions = 0;
    for (const h of fileState.hunks) {
      additions += h.addedLines.length;
      deletions += h.deletedCount;
    }
    this._onDidUpdateHunkStats.fire({
      checkpointId: fileState.checkpointId,
      filePath: fileState.filePath,
      additions,
      deletions
    });
  }

  /**
   * If all hunks in a file are resolved, remove it from the session.
   * If all files are resolved, close the review.
   * Emits onDidResolveFile so the files-changed widget can update.
   */
  private async checkFileFullyReviewed(fileState: FileReviewState): Promise<void> {
    if (fileState.hunks.length > 0) return;
    if (!this.activeSession) return;

    // Determine if file was fully undone (matches original) or kept (still differs)
    let action: 'kept' | 'undone' = 'kept';
    try {
      const snapshot = await this.databaseService.getSnapshotForFile(
        fileState.checkpointId, fileState.filePath
      );
      if (snapshot) {
        const currentData = await vscode.workspace.fs.readFile(fileState.uri);
        const currentContent = new TextDecoder().decode(currentData);
        const originalContent = snapshot.original_content ?? '';
        // Normalize: trim trailing newline differences
        const normCurrent = currentContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
        const normOriginal = originalContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
        if (normCurrent === normOriginal) {
          action = 'undone';
        } else {
          // Double-check via diff — if no real changes, it's undone
          const patch = structuredPatch('a', 'b', normOriginal, normCurrent, '', '', { context: 0 });
          if (patch.hunks.length === 0) {
            action = 'undone';
          }
        }
      }
    } catch { /* can't read → assume kept */ }

    // Emit event BEFORE removing from session
    this._onDidResolveFile.fire({
      checkpointId: fileState.checkpointId,
      filePath: fileState.filePath,
      action
    });

    // Dispose decorations for this file
    fileState.addedDecoration.dispose();
    fileState.deletedDecoration.dispose();

    const idx = this.activeSession.files.indexOf(fileState);
    if (idx >= 0) {
      this.activeSession.files.splice(idx, 1);
      if (this.activeSession.currentFileIndex >= this.activeSession.files.length) {
        this.activeSession.currentFileIndex = Math.max(0, this.activeSession.files.length - 1);
      }
    }

    if (this.activeSession.files.length === 0) {
      this.closeReview();
    } else {
      this.codeLensProvider.refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Session building
  // ---------------------------------------------------------------------------

  private async buildReviewSession(checkpointId: string): Promise<void> {
    // Close any existing session
    this.closeReview();

    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    if (snapshots.length === 0) return;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    const files: FileReviewState[] = [];
    for (const snap of snapshots) {
      if (snap.file_status !== 'pending') continue; // only review pending files

      const absPath = path.join(workspaceRoot, snap.file_path);
      const uri = vscode.Uri.file(absPath);

      let currentContent = '';
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        currentContent = new TextDecoder().decode(data);
      } catch {
        continue; // file deleted or inaccessible
      }

      const originalContent = snap.original_content ?? '';
      const hunks = this.computeHunks(originalContent, currentContent);

      // Per-file decoration types so we can dispose them independently
      const addedDec = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
        isWholeLine: true,
        overviewRulerColor: new vscode.ThemeColor('minimapGutter.addedBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left
      });

      const deletedDec = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
        isWholeLine: true,
        overviewRulerColor: new vscode.ThemeColor('minimapGutter.deletedBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left
      });

      files.push({
        uri,
        checkpointId,
        filePath: snap.file_path,
        hunks,
        addedDecoration: addedDec,
        deletedDecoration: deletedDec,
        currentHunkIndex: 0
      });
    }

    if (files.length === 0) return;

    this.activeSession = {
      checkpointId,
      files,
      currentFileIndex: 0
    };

    vscode.commands.executeCommand('setContext', 'ollamaCopilot.reviewActive', true);

    // Register CodeLens for all file languages
    if (this.codeLensDisposable) this.codeLensDisposable.dispose();
    this.codeLensDisposable = vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      this.codeLensProvider
    );

    this._onDidChangeReviewState.fire();
  }

  // ---------------------------------------------------------------------------
  // Hunk computation
  // ---------------------------------------------------------------------------

  private computeHunks(original: string, current: string): ReviewHunk[] {
    const patch = structuredPatch('a', 'b', original, current, '', '', { context: 0 });
    const hunks: ReviewHunk[] = [];

    for (const patchHunk of patch.hunks) {
      const addedLines: number[] = [];
      let deletedCount = 0;
      let currentLine = patchHunk.newStart - 1; // 0-based

      const origLines: string[] = [];
      const newLines: string[] = [];

      for (const line of patchHunk.lines) {
        if (line.startsWith('+')) {
          addedLines.push(currentLine);
          newLines.push(line.substring(1));
          currentLine++;
        } else if (line.startsWith('-')) {
          deletedCount++;
          origLines.push(line.substring(1));
        } else {
          // context line
          currentLine++;
        }
      }

      if (addedLines.length === 0 && deletedCount === 0) continue;

      const startLine = addedLines.length > 0 ? addedLines[0] : (patchHunk.newStart - 1);
      const endLine = addedLines.length > 0 ? addedLines[addedLines.length - 1] : startLine;

      hunks.push({
        startLine,
        endLine,
        addedLines,
        deletedCount,
        originalText: origLines.join('\n'),
        newText: newLines.join('\n')
      });
    }

    return hunks;
  }

  // ---------------------------------------------------------------------------
  // File opening + decoration
  // ---------------------------------------------------------------------------

  private async openAndDecorateFile(fileIndex: number): Promise<void> {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[fileIndex];
    if (!fileState) return;

    // Open the actual file
    const doc = await vscode.workspace.openTextDocument(fileState.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false
    });

    // Apply decorations
    this.applyDecorations(editor, fileState);

    // Scroll to first hunk
    if (fileState.hunks.length > 0) {
      fileState.currentHunkIndex = 0;
      this.scrollToHunk(fileState);
    }

    // Trigger CodeLens refresh
    this.codeLensProvider.refresh();
  }

  private applyDecorations(editor: vscode.TextEditor, fileState: FileReviewState): void {
    const addedRanges: vscode.DecorationOptions[] = [];
    const deletedRanges: vscode.DecorationOptions[] = [];

    for (const hunk of fileState.hunks) {
      // Green highlight for added lines
      for (const line of hunk.addedLines) {
        if (line < editor.document.lineCount) {
          addedRanges.push({ range: new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length) });
        }
      }

      // Red marker at the start of each hunk that has deletions
      if (hunk.deletedCount > 0) {
        const markerLine = hunk.startLine > 0 ? hunk.startLine - 1 : 0;
        if (markerLine < editor.document.lineCount) {
          deletedRanges.push({
            range: new vscode.Range(markerLine, 0, markerLine, 0),
            hoverMessage: new vscode.MarkdownString(`**${hunk.deletedCount} line(s) removed:**\n\`\`\`\n${hunk.originalText}\n\`\`\``)
          });
        }
      }
    }

    editor.setDecorations(fileState.addedDecoration, addedRanges);
    editor.setDecorations(fileState.deletedDecoration, deletedRanges);
  }

  /** Re-apply decorations if the user switches tabs to a file in the review. */
  private applyDecorationsForEditor(editor: vscode.TextEditor): void {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files.find(f => f.uri.toString() === editor.document.uri.toString());
    if (fileState) {
      this.applyDecorations(editor, fileState);
      // Update current file index
      const idx = this.activeSession.files.indexOf(fileState);
      if (idx >= 0) {
        this.activeSession.currentFileIndex = idx;
      }
    }
  }

  private scrollToHunk(fileState: FileReviewState): void {
    const hunk = fileState.hunks[fileState.currentHunkIndex];
    if (!hunk) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== fileState.uri.toString()) return;

    const range = new vscode.Range(hunk.startLine, 0, hunk.endLine, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(hunk.startLine, 0, hunk.startLine, 0);
  }

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.closeReview();
    this._onDidChangeReviewState.dispose();
    this._onDidResolveFile.dispose();
    this._onDidUpdateHunkStats.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

// =============================================================================
// CodeLens provider
// =============================================================================

class ReviewCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly service: PendingEditReviewService) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const fileState = this.service.getFileState(document.uri);
    if (!fileState) return [];

    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < fileState.hunks.length; i++) {
      const hunk = fileState.hunks[i];
      const range = new vscode.Range(hunk.startLine, 0, hunk.startLine, 0);

      // "Keep" lens
      lenses.push(new vscode.CodeLens(range, {
        title: '✓ Keep',
        command: 'ollamaCopilot.reviewKeepHunk',
        arguments: [fileState.filePath, i]
      }));

      // "Undo" lens
      lenses.push(new vscode.CodeLens(range, {
        title: '↩ Undo',
        command: 'ollamaCopilot.reviewUndoHunk',
        arguments: [fileState.filePath, i]
      }));

      // Separator with change info
      const info = `+${hunk.addedLines.length} -${hunk.deletedCount}`;
      lenses.push(new vscode.CodeLens(range, {
        title: info,
        command: ''
      }));
    }

    return lenses;
  }
}
