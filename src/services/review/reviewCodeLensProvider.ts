import * as vscode from 'vscode';
import type { PendingEditReviewService } from './pendingEditReviewService';

// =============================================================================
// CodeLens provider — shows Keep/Undo actions inline for each review hunk.
// Extracted from PendingEditReviewService to keep the file manageable.
// =============================================================================

export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
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

      lenses.push(new vscode.CodeLens(range, {
        title: '✓ Keep',
        command: 'ollamaCopilot.reviewKeepHunk',
        arguments: [fileState.filePath, i]
      }));

      lenses.push(new vscode.CodeLens(range, {
        title: '✕ Undo',
        command: 'ollamaCopilot.reviewUndoHunk',
        arguments: [fileState.filePath, i]
      }));

      const info = `+${hunk.addedLines.length} -${hunk.deletedCount}`;
      lenses.push(new vscode.CodeLens(range, {
        title: info,
        command: ''
      }));
    }

    return lenses;
  }
}
