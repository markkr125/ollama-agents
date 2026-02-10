import { structuredPatch } from 'diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from '../database/databaseService';
import { FileReviewState, ReviewHunk, ReviewSession } from './reviewTypes';

// =============================================================================
// ReviewSessionBuilder — constructs a ReviewSession from checkpoint snapshots.
//
// Pure construction logic: reads snapshots from the database, computes diff
// hunks, and builds FileReviewState objects with decoration types. Does NOT
// own the session lifecycle — that remains in PendingEditReviewService.
// =============================================================================

export class ReviewSessionBuilder {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Build a ReviewSession from one or more checkpoint IDs.
   *
   * Returns `null` if no pending files are found (all resolved or no snapshots).
   * The caller is responsible for closing any previous session before calling.
   */
  async buildSession(checkpointIds: string[]): Promise<ReviewSession | null> {
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
        const hunks = computeHunks(originalContent, currentContent);

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

    if (files.length === 0) return null;

    return {
      checkpointIds,
      files,
      currentFileIndex: 0
    };
  }
}

// =============================================================================
// computeHunks — diff two strings and return ReviewHunk[]
// =============================================================================

/**
 * Compute review hunks by structured-diffing `original` against `current`.
 * Each hunk tracks added/deleted lines and preserves the original text for undo.
 */
export function computeHunks(original: string, current: string): ReviewHunk[] {
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
