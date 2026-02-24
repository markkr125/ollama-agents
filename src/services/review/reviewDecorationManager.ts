import * as vscode from 'vscode';
import { ReviewCodeLensProvider } from './reviewCodeLensProvider';
import { FileReviewState, ReviewSession } from './reviewTypes';

// =============================================================================
// ReviewDecorationManager — owns all VS Code editor decorations for inline
// review: added/deleted line highlights, gutter arrow, and file opening.
//
// Stateless regarding the review session — receives session/fileState as
// parameters. The PendingEditReviewService facade passes these in.
// =============================================================================

export class ReviewDecorationManager {
  /** Instant gutter arrow for the currently focused hunk */
  readonly gutterArrowDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      contentText: '▸',
      color: new vscode.ThemeColor('editorLineNumber.activeForeground'),
      fontWeight: 'bold',
      margin: '0 4px 0 0'
    }
  });

  constructor(private readonly codeLensProvider: ReviewCodeLensProvider) {}

  /**
   * Open a file from the session at `fileIndex`, apply decorations, and
   * scroll to the first hunk.
   */
  async openAndDecorateFile(session: ReviewSession, fileIndex: number): Promise<void> {
    const fileState = session.files[fileIndex];
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

  /**
   * Set added/deleted decorations on `editor` for the given file's hunks.
   */
  applyDecorations(editor: vscode.TextEditor, fileState: FileReviewState): void {
    const addedRanges: vscode.DecorationOptions[] = [];
    const deletedRanges: vscode.DecorationOptions[] = [];

    for (const hunk of fileState.hunks) {
      for (const line of hunk.addedLines) {
        if (line < editor.document.lineCount) {
          addedRanges.push({
            range: new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length)
          });
        }
      }

      if (hunk.deletedCount > 0) {
        const markerLine = hunk.startLine > 0 ? hunk.startLine - 1 : 0;
        if (markerLine < editor.document.lineCount) {
          deletedRanges.push({
            range: new vscode.Range(markerLine, 0, markerLine, 0),
            hoverMessage: new vscode.MarkdownString(
              `**${hunk.deletedCount} line(s) removed:**\n\`\`\`\n${hunk.originalText}\n\`\`\``
            )
          });
        }
      }
    }

    editor.setDecorations(fileState.addedDecoration, addedRanges);
    editor.setDecorations(fileState.deletedDecoration, deletedRanges);
  }

  /**
   * Re-apply decorations when the active editor changes (tab switch).
   * Returns the matched file index so the facade can update `currentFileIndex`
   * — this method does NOT mutate session state directly.
   */
  applyDecorationsForEditor(session: ReviewSession, editor: vscode.TextEditor): number | undefined {
    const fileState = session.files.find(
      f => f.uri.toString() === editor.document.uri.toString()
    );
    if (fileState) {
      this.applyDecorations(editor, fileState);
      const idx = session.files.indexOf(fileState);
      if (idx >= 0) return idx;
    }
    return undefined;
  }

  /**
   * Refresh decorations for a single file (after hunk keep/undo).
   */
  refreshDecorationsForFile(fileState: FileReviewState): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === fileState.uri.toString()) {
      this.applyDecorations(editor, fileState);
    }
    this.codeLensProvider.refresh();
  }

  /**
   * Scroll the active editor to `fileState.currentHunkIndex` and show the
   * gutter arrow. Clears the arrow if the hunk doesn't exist.
   */
  scrollToHunk(fileState: FileReviewState): void {
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
  clearGutterArrow(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.gutterArrowDecoration, []);
    }
  }

  /** Dispose the gutter arrow decoration type. */
  dispose(): void {
    this.gutterArrowDecoration.dispose();
  }
}
