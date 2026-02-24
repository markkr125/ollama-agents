import { structuredPatch } from 'diff';
import * as vscode from 'vscode';
import { AsyncMutex } from '../../utils/asyncMutex';
import { DatabaseService } from '../database/databaseService';
import { ReviewCodeLensProvider } from './reviewCodeLensProvider';
import { ReviewDecorationManager } from './reviewDecorationManager';
import { ReviewNavigator } from './reviewNavigator';
import { ReviewSessionBuilder } from './reviewSessionBuilder';
import type {
    ChangePosition,
    FileHunkStatsEvent,
    FileReviewResolvedEvent,
    FileReviewState,
    ReviewPhase,
    ReviewSession
} from './reviewTypes';

// Re-export types so existing consumers don't need to change imports.
export type { FileHunkStatsEvent, FileReviewResolvedEvent, FileReviewState, ReviewHunk, ReviewPhase } from './reviewTypes';

// =============================================================================
// PendingEditReviewService — thin facade that composes:
//   • ReviewSessionBuilder  — session construction from DB snapshots
//   • ReviewNavigator       — pure navigation math (stateless)
//   • ReviewDecorationManager — VS Code editor decorations
//   • AsyncMutex            — serialises concurrent session builds
//
// This class owns session state, event emitters, and lifecycle (close/dispose).
// Hunk keep/undo operations remain here because they tightly couple session
// mutation, editor edits, event emission, and decoration refresh.
// =============================================================================

export class PendingEditReviewService implements vscode.Disposable {
  private activeSession: ReviewSession | null = null;
  private _phase: ReviewPhase = 'idle';
  private disposables: vscode.Disposable[] = [];

  // Sub-components
  private readonly mutex = new AsyncMutex();
  private readonly sessionBuilder: ReviewSessionBuilder;
  private readonly navigator = new ReviewNavigator();
  private readonly codeLensProvider: ReviewCodeLensProvider;
  private readonly decorationMgr: ReviewDecorationManager;
  private codeLensDisposable: vscode.Disposable | null = null;

  // Events
  private _onDidChangeReviewState = new vscode.EventEmitter<void>();
  readonly onDidChangeReviewState = this._onDidChangeReviewState.event;

  private _onDidResolveFile = new vscode.EventEmitter<FileReviewResolvedEvent>();
  readonly onDidResolveFile = this._onDidResolveFile.event;

  private _onDidUpdateHunkStats = new vscode.EventEmitter<FileHunkStatsEvent>();
  readonly onDidUpdateHunkStats = this._onDidUpdateHunkStats.event;

  constructor(private readonly databaseService: DatabaseService) {
    this.sessionBuilder = new ReviewSessionBuilder(databaseService);
    this.codeLensProvider = new ReviewCodeLensProvider(this);
    this.decorationMgr = new ReviewDecorationManager(this.codeLensProvider);

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && this.activeSession && this._phase === 'active') {
          const idx = this.decorationMgr.applyDecorationsForEditor(this.activeSession, editor);
          if (idx !== undefined) {
            this.activeSession.currentFileIndex = idx;
          }
        }
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Phase tracking — explicit state machine (see ReviewPhase in reviewTypes.ts)
  // ---------------------------------------------------------------------------

  /** Current lifecycle phase. */
  getPhase(): ReviewPhase {
    return this._phase;
  }

  /**
   * Transition to a new phase with validation.
   * Warns (but does not throw) on invalid transitions to avoid crashing
   * during edge-case races.
   */
  private transition(to: ReviewPhase): void {
    const from = this._phase;
    const valid =
      (from === 'idle' && to === 'building') ||
      (from === 'building' && (to === 'active' || to === 'idle')) ||
      (from === 'active' && (to === 'building' || to === 'idle'));
    if (!valid) {
      console.warn(`[ReviewService] Invalid phase transition: ${from} → ${to}`);
    }
    this._phase = to;
  }

  // ---------------------------------------------------------------------------
  // Accessors (used by CodeLensProvider and external consumers)
  // ---------------------------------------------------------------------------

  getActiveSession(): ReviewSession | null {
    return this.activeSession;
  }

  getFileState(uri: vscode.Uri): FileReviewState | undefined {
    return this.activeSession?.files.find(f => f.uri.toString() === uri.toString());
  }

  // ---------------------------------------------------------------------------
  // Public API — session lifecycle
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

    await this.mutex.runExclusive(async () => {
      const mergedIds = this.activeSession
        ? [...new Set([...this.activeSession.checkpointIds, resolvedCheckpointId])]
        : [resolvedCheckpointId];

      let idx = this.activeSession?.files.findIndex(f => f.filePath === filePath) ?? -1;
      if (idx < 0) {
        await this.rebuildSession(mergedIds);
      }

      if (!this.activeSession) return;

      idx = this.activeSession.files.findIndex(f => f.filePath === filePath);
      if (idx < 0) {
        vscode.window.showWarningMessage(`File ${filePath} not found in review session`);
        return;
      }

      this.activeSession.currentFileIndex = idx;
      await this.decorationMgr.openAndDecorateFile(this.activeSession, idx);
    });
  }

  async startReviewForCheckpoint(checkpointId: string | string[]): Promise<void> {
    const ids = Array.isArray(checkpointId) ? checkpointId : [checkpointId];
    if (ids.length === 0) return;

    await this.mutex.runExclusive(async () => {
      const mergedIds = this.activeSession
        ? [...new Set([...this.activeSession.checkpointIds, ...ids])]
        : ids;

      await this.rebuildSession(mergedIds);
      if (!this.activeSession) return;

      // Apply decorations to visible editors and track which review file
      // the user is currently viewing so activeFilePath stays accurate.
      let visibleFileIdx = -1;
      const activeEditor = vscode.window.activeTextEditor;
      for (const editor of vscode.window.visibleTextEditors) {
        const idx = this.activeSession.files.findIndex(
          f => f.uri.toString() === editor.document.uri.toString()
        );
        if (idx >= 0) {
          this.decorationMgr.applyDecorations(editor, this.activeSession.files[idx]);
          // Prefer the focused/active editor; fallback to any visible one
          if (activeEditor && editor.document.uri.toString() === activeEditor.document.uri.toString()) {
            visibleFileIdx = idx;
          } else if (visibleFileIdx < 0) {
            visibleFileIdx = idx;
          }
        }
      }

      // Update currentFileIndex to the currently visible file so that
      // getChangePosition() returns the correct filePath for the widget.
      if (visibleFileIdx >= 0) {
        this.activeSession.currentFileIndex = visibleFileIdx;
      }
    });
  }

  removeFileFromReview(filePath: string): void {
    if (!this.activeSession || this._phase !== 'active') return;

    const idx = this.activeSession.files.findIndex(f => f.filePath === filePath);
    if (idx < 0) return;

    const fileState = this.activeSession.files[idx];
    fileState.addedDecoration.dispose();
    fileState.deletedDecoration.dispose();
    this.decorationMgr.clearGutterArrow();
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
    if (!this.activeSession) {
      this._phase = 'idle';
      return;
    }

    for (const fileState of this.activeSession.files) {
      fileState.addedDecoration.dispose();
      fileState.deletedDecoration.dispose();
    }

    this.decorationMgr.clearGutterArrow();

    if (this.codeLensDisposable) {
      this.codeLensDisposable.dispose();
      this.codeLensDisposable = null;
    }

    this.activeSession = null;
    this._phase = 'idle';
    vscode.commands.executeCommand('setContext', 'ollamaCopilot.reviewActive', false);
    this._onDidChangeReviewState.fire();
  }

  // ---------------------------------------------------------------------------
  // Navigation — delegates math to ReviewNavigator, applies side effects here
  // ---------------------------------------------------------------------------

  async navigateFile(direction: 'prev' | 'next'): Promise<void> {
    if (!this.activeSession || this._phase !== 'active' || this.activeSession.files.length === 0) return;

    this.activeSession.currentFileIndex =
      this.navigator.computeFileNavigation(this.activeSession, direction);
    await this.decorationMgr.openAndDecorateFile(this.activeSession, this.activeSession.currentFileIndex);
  }

  async navigateHunk(direction: 'prev' | 'next', checkpointId?: string): Promise<void> {
    let justBuilt = false;
    if (!this.activeSession && checkpointId) {
      await this.rebuildSession([checkpointId]);
      justBuilt = true;
    }

    if (!this.activeSession) return;

    if (justBuilt && this.activeSession.files.length > 0) {
      await this.decorationMgr.openAndDecorateFile(this.activeSession, 0);
      return;
    }

    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;

    fileState.currentHunkIndex =
      this.navigator.computeHunkNavigation(this.activeSession, direction);
    this.decorationMgr.scrollToHunk(fileState);
  }

  async navigateChange(
    direction: 'prev' | 'next',
    checkpointId?: string | string[]
  ): Promise<ChangePosition | null> {
    const ids = checkpointId
      ? (Array.isArray(checkpointId) ? checkpointId : [checkpointId])
      : undefined;

    if (ids?.length) {
      const needsBuild = !this.activeSession
        || !ids.every(id => this.activeSession!.checkpointIds.includes(id));
      if (needsBuild) {
        await this.mutex.runExclusive(async () => {
          const mergedIds = this.activeSession
            ? [...new Set([...this.activeSession.checkpointIds, ...ids])]
            : ids;
          await this.rebuildSession(mergedIds);
        });
        if (!this.activeSession || this.activeSession.files.length === 0) return null;
      }
    }

    if (!this.activeSession || this.activeSession.files.length === 0) return null;

    const target = this.navigator.computeChangeNavigation(this.activeSession, direction);
    if (!target) return null;

    if (target.needsFileOpen) {
      this.activeSession.currentFileIndex = target.fileIndex;
      await this.decorationMgr.openAndDecorateFile(this.activeSession, target.fileIndex);
    }

    this.activeSession.files[target.fileIndex].currentHunkIndex = target.hunkIndex;
    this.decorationMgr.scrollToHunk(this.activeSession.files[target.fileIndex]);

    return this.navigator.getChangePosition(this.activeSession);
  }

  getChangePosition(checkpointId?: string | string[]): ChangePosition | null {
    if (!this.activeSession) return null;
    if (checkpointId) {
      const ids = Array.isArray(checkpointId) ? checkpointId : [checkpointId];
      if (!ids.some(id => this.activeSession!.checkpointIds.includes(id))) return null;
    }
    return this.navigator.getChangePosition(this.activeSession);
  }

  // ---------------------------------------------------------------------------
  // Hunk operations — keep/undo
  // ---------------------------------------------------------------------------

  async keepHunk(filePath: string, hunkIndex: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this._phase !== 'active') return;

      const fileState = this.findFileByPath(filePath);
      if (!fileState || hunkIndex < 0 || hunkIndex >= fileState.hunks.length) return;

      fileState.hunks.splice(hunkIndex, 1);

      if (fileState.hunks.length === 0) {
        fileState.currentHunkIndex = 0;
      } else if (fileState.currentHunkIndex >= fileState.hunks.length) {
        fileState.currentHunkIndex = fileState.hunks.length - 1;
      }

      this.decorationMgr.refreshDecorationsForFile(fileState);
      this.emitHunkStats(fileState);
      await this.checkFileFullyReviewed(fileState);

      if (fileState.hunks.length > 0) {
        this.decorationMgr.scrollToHunk(fileState);
      } else {
        this.decorationMgr.clearGutterArrow();
      }
    });
  }

  async undoHunk(filePath: string, hunkIndex: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this._phase !== 'active') return;

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

      this.decorationMgr.refreshDecorationsForFile(fileState);
      this.emitHunkStats(fileState);
      await this.checkFileFullyReviewed(fileState);

      if (fileState.hunks.length > 0) {
        this.decorationMgr.scrollToHunk(fileState);
      } else {
        this.decorationMgr.clearGutterArrow();
      }
    });
  }

  async keepCurrentHunk(): Promise<void> {
    if (!this.activeSession) return;
    const fileState = this.activeSession.files[this.activeSession.currentFileIndex];
    if (!fileState || fileState.hunks.length === 0) return;
    await this.keepHunk(fileState.filePath, fileState.currentHunkIndex);
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
  // Session building — delegates to ReviewSessionBuilder
  // ---------------------------------------------------------------------------

  /**
   * Build or incrementally merge a review session from the given checkpoint IDs.
   *
   * **Incremental merge** (pitfall 17/24 fix): When the current session already
   * exists and the requested IDs are a strict superset, only the NEW checkpoint's
   * files are built and appended — `currentFileIndex` is preserved.
   *
   * **Full rebuild**: When checkpoint IDs overlap (re-edit case) or no session
   * exists, the old session is closed and a fresh one is built from scratch.
   */
  private async rebuildSession(checkpointIds: string[]): Promise<void> {
    // --- Incremental merge path ---
    if (this.activeSession) {
      const existingIds = new Set(this.activeSession.checkpointIds);
      const newIds = checkpointIds.filter(id => !existingIds.has(id));

      if (newIds.length > 0 && checkpointIds.length > existingIds.size) {
        // Adding new checkpoints — merge without destroying session
        this.transition('building');
        const partial = await this.sessionBuilder.buildSession(newIds);
        if (partial) {
          this.activeSession.checkpointIds = [
            ...new Set([...this.activeSession.checkpointIds, ...newIds])
          ];
          this.activeSession.files.push(...partial.files);
        }
        this.transition('active');
        this._onDidChangeReviewState.fire();
        return;
      }

      if (newIds.length === 0) {
        // Same checkpoints — re-edit case. Fall through to full rebuild
        // to pick up changed snapshot content.
      }
    }

    // --- Full rebuild path ---
    this.closeReview();
    this.transition('building');

    const session = await this.sessionBuilder.buildSession(checkpointIds);
    if (!session) {
      this._phase = 'idle';
      return;
    }

    this.activeSession = session;
    this.transition('active');

    vscode.commands.executeCommand('setContext', 'ollamaCopilot.reviewActive', true);

    if (this.codeLensDisposable) this.codeLensDisposable.dispose();
    this.codeLensDisposable = vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      this.codeLensProvider
    );

    this._onDidChangeReviewState.fire();
  }

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.closeReview();
    this.decorationMgr.dispose();
    this._onDidChangeReviewState.dispose();
    this._onDidResolveFile.dispose();
    this._onDidUpdateHunkStats.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
