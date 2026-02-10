import { structuredPatch } from 'diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from '../database/databaseService';
import { ReviewCodeLensProvider } from './reviewCodeLensProvider';

/**
 * A single contiguous hunk of changes in a file.
 */
export interface ReviewHunk {
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
export interface FileReviewState {
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
 * Tracks the full review session (files across one or more checkpoints).
 */
interface ReviewSession {
  checkpointIds: string[];
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

  // Mutex — serialises operations that read activeSession then call buildReviewSession.
  private _buildLock: Promise<void> = Promise.resolve();

  // CodeLens
  private codeLensProvider: ReviewCodeLensProvider;
  private codeLensDisposable: vscode.Disposable | null = null;

  // Instant gutter arrow for the currently focused hunk
  private gutterArrowDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      contentText: '▸',
      color: new vscode.ThemeColor('editorLineNumber.activeForeground'),
      fontWeight: 'bold',
      margin: '0 4px 0 0'
    }
  });

  // Event: fires whenever review state changes (for external consumers)
  private _onDidChangeReviewState = new vscode.EventEmitter<void>();
  readonly onDidChangeReviewState = this._onDidChangeReviewState.event;

  // Event: fires when all hunks in a file are resolved
  private _onDidResolveFile = new vscode.EventEmitter<FileReviewResolvedEvent>();
  readonly onDidResolveFile = this._onDidResolveFile.event;

  // Event: fires when a hunk is resolved (for widget stats sync)
  private _onDidUpdateHunkStats = new vscode.EventEmitter<FileHunkStatsEvent>();
  readonly onDidUpdateHunkStats = this._onDidUpdateHunkStats.event;

  private async withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._buildLock;
    let release!: () => void;
    this._buildLock = new Promise<void>(r => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  constructor(private readonly databaseService: DatabaseService) {
    this.codeLensProvider = new ReviewCodeLensProvider(this);

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
  // Public API — called from agentChatExecutor / chatView
  // ---------------------------------------------------------------------------

  async openFileReview(
    checkpointId: string,
    filePath: string,
    sessionId?: string
  ): Promise<void> {
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

    await this.withBuildLock(async () => {
      const mergedIds = this.activeSession
        ? [...new Set([...this.activeSession.checkpointIds, resolvedCheckpointId])]
        : [resolvedCheckpointId];

      let idx = this.activeSession?.files.findIndex(f => f.filePath === filePath) ?? -1;
      if (idx < 0) {
        await this.buildReviewSession(mergedIds);
      }

      if (!this.activeSession) return;

      idx = this.activeSession.files.findIndex(f => f.filePath === filePath);
      if (idx < 0) {
        vscode.window.showWarningMessage(`File ${filePath} not found in review session`);
        return;
      }

      this.activeSession.currentFileIndex = idx;
      await this.openAndDecorateFile(idx);
    });
  }

  async startReviewForCheckpoint(checkpointId: string | string[]): Promise<void> {
    const ids = Array.isArray(checkpointId) ? checkpointId : [checkpointId];
    if (ids.length === 0) return;

    await this.withBuildLock(async () => {
      const mergedIds = this.activeSession
        ? [...new Set([...this.activeSession.checkpointIds, ...ids])]
        : ids;

      await this.buildReviewSession(mergedIds);
      if (!this.activeSession) return;

      for (const editor of vscode.window.visibleTextEditors) {
        const fileState = this.activeSession.files.find(
          f => f.uri.toString() === editor.document.uri.toString()
        );
        if (fileState) {
          this.applyDecorations(editor, fileState);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

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

  async navigateHunk(direction: 'prev' | 'next', checkpointId?: string): Promise<void> {
    if (!this.activeSession && checkpointId) {
      await this.buildReviewSession([checkpointId]);
      if (this.activeSession !== null && (this.activeSession as ReviewSession).files.length > 0) {
        await this.openAndDecorateFile(0);
        return;
      }
    }

    if (this.activeSession === null) return;
    const session = this.activeSession as ReviewSession;
    const fileState = session.files[session.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;

    if (direction === 'next') {
      fileState.currentHunkIndex = (fileState.currentHunkIndex + 1) % fileState.hunks.length;
    } else {
      fileState.currentHunkIndex = (fileState.currentHunkIndex - 1 + fileState.hunks.length) % fileState.hunks.length;
    }

    this.scrollToHunk(fileState);
  }

  async navigateChange(
    direction: 'prev' | 'next',
    checkpointId?: string | string[]
  ): Promise<{ current: number; total: number; filePath?: string } | null> {
    const ids = checkpointId ? (Array.isArray(checkpointId) ? checkpointId : [checkpointId]) : undefined;

    if (ids?.length) {
      const needsBuild = !this.activeSession
        || !ids.every(id => this.activeSession!.checkpointIds.includes(id));
      if (needsBuild) {
        await this.withBuildLock(async () => {
          const mergedIds = this.activeSession
            ? [...new Set([...this.activeSession.checkpointIds, ...ids])]
            : ids;
          await this.buildReviewSession(mergedIds);
        });
        if (!this.activeSession || this.activeSession.files.length === 0) return null;
      }
    }

    if (this.activeSession === null) return null;
    const session = this.activeSession as ReviewSession;
    if (session.files.length === 0) return null;

    const flat: { fileIdx: number; hunkIdx: number }[] = [];
    for (let fi = 0; fi < session.files.length; fi++) {
      for (let hi = 0; hi < session.files[fi].hunks.length; hi++) {
        flat.push({ fileIdx: fi, hunkIdx: hi });
      }
    }

    if (flat.length === 0) return null;

    const currentFlat = flat.findIndex(
      e => e.fileIdx === session.currentFileIndex
        && e.hunkIdx === session.files[session.currentFileIndex]?.currentHunkIndex
    );

    let nextFlat: number;
    if (currentFlat < 0) {
      nextFlat = direction === 'next' ? 0 : flat.length - 1;
    } else if (direction === 'next') {
      nextFlat = (currentFlat + 1) % flat.length;
    } else {
      nextFlat = (currentFlat - 1 + flat.length) % flat.length;
    }

    const target = flat[nextFlat];

    if (target.fileIdx !== session.currentFileIndex) {
      session.currentFileIndex = target.fileIdx;
      await this.openAndDecorateFile(target.fileIdx);
    }

    session.files[target.fileIdx].currentHunkIndex = target.hunkIdx;
    this.scrollToHunk(session.files[target.fileIdx]);

    return { current: nextFlat + 1, total: flat.length, filePath: session.files[target.fileIdx].filePath };
  }

  getChangePosition(checkpointId?: string | string[]): { current: number; total: number; filePath?: string } | null {
    if (!this.activeSession) return null;
    if (checkpointId) {
      const ids = Array.isArray(checkpointId) ? checkpointId : [checkpointId];
      if (!ids.some(id => this.activeSession!.checkpointIds.includes(id))) return null;
    }
    return this.getGlobalChangePosition(this.activeSession);
  }

  private getGlobalChangePosition(session: ReviewSession): { current: number; total: number; filePath?: string } {
    let total = 0;
    let current = 0;
    let found = false;
    for (let fi = 0; fi < session.files.length; fi++) {
      const file = session.files[fi];
      for (let hi = 0; hi < file.hunks.length; hi++) {
        total++;
        if (!found && fi === session.currentFileIndex && hi === file.currentHunkIndex) {
          current = total;
          found = true;
        }
      }
    }
    if (!found) current = total > 0 ? 1 : 0;
    const filePath = session.files[session.currentFileIndex]?.filePath;
    return { current, total, filePath };
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  removeFileFromReview(filePath: string): void {
    if (!this.activeSession) return;

    const idx = this.activeSession.files.findIndex(f => f.filePath === filePath);
    if (idx < 0) return;

    const fileState = this.activeSession.files[idx];
    fileState.addedDecoration.dispose();
    fileState.deletedDecoration.dispose();
    this.clearGutterArrow();
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

  closeReview(): void {
    if (!this.activeSession) return;

    for (const fileState of this.activeSession.files) {
      fileState.addedDecoration.dispose();
      fileState.deletedDecoration.dispose();
    }

    this.clearGutterArrow();

    if (this.codeLensDisposable) {
      this.codeLensDisposable.dispose();
      this.codeLensDisposable = null;
    }

    this.activeSession = null;
    vscode.commands.executeCommand('setContext', 'ollamaCopilot.reviewActive', false);
    this._onDidChangeReviewState.fire();
  }

  // ---------------------------------------------------------------------------
  // Hunk operations — keep/undo
  // ---------------------------------------------------------------------------

  keepHunk(filePath: string, hunkIndex: number): void {
    const fileState = this.findFileByPath(filePath);
    if (!fileState || hunkIndex < 0 || hunkIndex >= fileState.hunks.length) return;

    fileState.hunks.splice(hunkIndex, 1);

    if (fileState.hunks.length === 0) {
      fileState.currentHunkIndex = 0;
    } else if (fileState.currentHunkIndex >= fileState.hunks.length) {
      fileState.currentHunkIndex = fileState.hunks.length - 1;
    }

    this.refreshDecorationsForFile(fileState);
    this.emitHunkStats(fileState);
    this.checkFileFullyReviewed(fileState);

    // Navigate to the next hunk (updates gutter arrow) or clear arrow if none remain
    if (fileState.hunks.length > 0) {
      this.scrollToHunk(fileState);
    } else {
      this.clearGutterArrow();
    }
  }

  async undoHunk(filePath: string, hunkIndex: number): Promise<void> {
    const fileState = this.findFileByPath(filePath);
    if (!fileState || hunkIndex < 0 || hunkIndex >= fileState.hunks.length) return;

    const hunk = fileState.hunks[hunkIndex];
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== fileState.uri.toString()) return;

    const doc = editor.document;

    const success = await editor.edit(editBuilder => {
      if (hunk.addedLines.length > 0 && !hunk.originalText) {
        const firstLine = hunk.addedLines[0];
        const lastLine = hunk.addedLines[hunk.addedLines.length - 1];

        if (lastLine + 1 < doc.lineCount) {
          editBuilder.delete(new vscode.Range(firstLine, 0, lastLine + 1, 0));
        } else if (firstLine > 0) {
          const prevEnd = doc.lineAt(firstLine - 1).range.end;
          const lastEnd = doc.lineAt(lastLine).range.end;
          editBuilder.delete(new vscode.Range(prevEnd, lastEnd));
        } else {
          const lastEnd = doc.lineAt(lastLine).range.end;
          editBuilder.delete(new vscode.Range(0, 0, lastEnd.line, lastEnd.character));
        }
      } else if (hunk.addedLines.length > 0 && hunk.originalText) {
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
        editBuilder.insert(
          new vscode.Position(hunk.startLine, 0),
          hunk.originalText + '\n'
        );
      }
    });

    if (!success) return;

    await editor.document.save();

    const addedLineCount = hunk.addedLines.length;
    const originalLineCount = hunk.originalText ? hunk.originalText.split('\n').length : 0;
    const delta = originalLineCount - addedLineCount;

    fileState.hunks.splice(hunkIndex, 1);

    for (let i = hunkIndex; i < fileState.hunks.length; i++) {
      const h = fileState.hunks[i];
      h.startLine += delta;
      h.endLine += delta;
      h.addedLines = h.addedLines.map(l => l + delta);
    }

    if (fileState.hunks.length === 0) {
      fileState.currentHunkIndex = 0;
    } else {
      fileState.currentHunkIndex = Math.min(hunkIndex, fileState.hunks.length - 1);
    }

    this.refreshDecorationsForFile(fileState);
    this.emitHunkStats(fileState);
    this.checkFileFullyReviewed(fileState);

    // Navigate to the next hunk (updates gutter arrow) or clear arrow if none remain
    if (fileState.hunks.length > 0) {
      this.scrollToHunk(fileState);
    } else {
      this.clearGutterArrow();
    }
  }

  keepCurrentHunk(): void {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;
    this.keepHunk(fileState.filePath, fileState.currentHunkIndex);
  }

  async undoCurrentHunk(): Promise<void> {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;
    await this.undoHunk(fileState.filePath, fileState.currentHunkIndex);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
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

  private async checkFileFullyReviewed(fileState: FileReviewState): Promise<void> {
    if (fileState.hunks.length > 0) return;
    if (!this.activeSession) return;

    let action: 'kept' | 'undone' = 'kept';
    try {
      const snapshot = await this.databaseService.getSnapshotForFile(
        fileState.checkpointId, fileState.filePath
      );
      if (snapshot) {
        const currentData = await vscode.workspace.fs.readFile(fileState.uri);
        const currentContent = new TextDecoder().decode(currentData);
        const originalContent = snapshot.original_content ?? '';
        const normCurrent = currentContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
        const normOriginal = originalContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
        if (normCurrent === normOriginal) {
          action = 'undone';
        } else {
          const patch = structuredPatch('a', 'b', normOriginal, normCurrent, '', '', { context: 0 });
          if (patch.hunks.length === 0) {
            action = 'undone';
          }
        }
      }
    } catch { /* can't read → assume kept */ }

    this._onDidResolveFile.fire({
      checkpointId: fileState.checkpointId,
      filePath: fileState.filePath,
      action
    });

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

  private async buildReviewSession(checkpointIds: string[]): Promise<void> {
    this.closeReview();

    const sortedIds = [...checkpointIds].sort();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const files: FileReviewState[] = [];
    const seenFiles = new Set<string>();

    for (const cpId of sortedIds) {
      const snapshots = await this.databaseService.getFileSnapshots(cpId);
      for (const snap of snapshots) {
        if (snap.file_status !== 'pending') continue;
        if (seenFiles.has(snap.file_path)) continue;
        seenFiles.add(snap.file_path);

        const absPath = path.join(workspaceRoot, snap.file_path);
        const uri = vscode.Uri.file(absPath);

        let currentContent = '';
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          currentContent = new TextDecoder().decode(data);
        } catch {
          continue;
        }

        const originalContent = snap.original_content ?? '';
        const hunks = this.computeHunks(originalContent, currentContent);

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
          checkpointId: cpId,
          filePath: snap.file_path,
          hunks,
          addedDecoration: addedDec,
          deletedDecoration: deletedDec,
          currentHunkIndex: 0
        });
      }
    }

    if (files.length === 0) return;

    this.activeSession = {
      checkpointIds,
      files,
      currentFileIndex: 0
    };

    vscode.commands.executeCommand('setContext', 'ollamaCopilot.reviewActive', true);

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
      let currentLine = patchHunk.newStart - 1;

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

    const doc = await vscode.workspace.openTextDocument(fileState.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false
    });

    this.applyDecorations(editor, fileState);

    if (fileState.hunks.length > 0) {
      fileState.currentHunkIndex = 0;
      this.scrollToHunk(fileState);
    }

    this.codeLensProvider.refresh();
  }

  private applyDecorations(editor: vscode.TextEditor, fileState: FileReviewState): void {
    const addedRanges: vscode.DecorationOptions[] = [];
    const deletedRanges: vscode.DecorationOptions[] = [];

    for (const hunk of fileState.hunks) {
      for (const line of hunk.addedLines) {
        if (line < editor.document.lineCount) {
          addedRanges.push({ range: new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length) });
        }
      }

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

  private applyDecorationsForEditor(editor: vscode.TextEditor): void {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files.find(f => f.uri.toString() === editor.document.uri.toString());
    if (fileState) {
      this.applyDecorations(editor, fileState);
      const idx = this.activeSession.files.indexOf(fileState);
      if (idx >= 0) {
        this.activeSession.currentFileIndex = idx;
      }
    }
  }

  private scrollToHunk(fileState: FileReviewState): void {
    const hunk = fileState.hunks[fileState.currentHunkIndex];
    if (!hunk) {
      this.clearGutterArrow();
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== fileState.uri.toString()) return;

    const range = new vscode.Range(hunk.startLine, 0, hunk.endLine, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(hunk.startLine, 0, hunk.startLine, 0);

    editor.setDecorations(this.gutterArrowDecoration, [
      { range: new vscode.Range(hunk.startLine, 0, hunk.startLine, 0) }
    ]);

    this.codeLensProvider.refresh();
  }

  /**
   * Clear the gutter arrow from whatever editor is showing it.
   * Safe to call even when no arrow is visible.
   */
  private clearGutterArrow(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.gutterArrowDecoration, []);
    }
  }

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.closeReview();
    this.gutterArrowDecoration.dispose();
    this._onDidChangeReviewState.dispose();
    this._onDidResolveFile.dispose();
    this._onDidUpdateHunkStats.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
