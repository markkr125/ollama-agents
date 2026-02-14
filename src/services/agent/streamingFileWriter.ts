import * as path from 'path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// StreamingFileWriter — streams file content directly into already-open
// editors as the LLM generates write_file/create_file arguments.
//
// Only touches files that the user already has open — no new tabs, no
// virtual documents, no side editors. If the file isn't open, the chat
// spinner ("Writing hello.ts — 42 lines") is the only feedback.
//
// Uses WorkspaceEdit to replace the document content in-place. The document
// is left dirty (unsaved) during streaming. The normal write_file tool
// execution at the end writes the final content to disk, which also
// saves the document.
// ---------------------------------------------------------------------------

export class StreamingFileWriter implements vscode.Disposable {
  /** Tracks which files we've started streaming into (by relative path). */
  private readonly activeFiles = new Map<string, {
    /** The original content before streaming started — for revert on cancel. */
    originalContent: string;
    /** The editor's document URI. */
    uri: vscode.Uri;
  }>();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Stream content into an already-open editor.
   * If the file isn't visible in any editor, this is a no-op.
   */
  async updateContent(relativePath: string, content: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return;

    const absPath = path.join(workspaceFolders[0].uri.fsPath, relativePath);
    const fileUri = vscode.Uri.file(absPath);

    // Find the editor showing this file
    const editor = vscode.window.visibleTextEditors.find(
      e => e.document.uri.fsPath === fileUri.fsPath
    );
    if (!editor) return; // File not open — chat spinner is enough

    // Capture original content on first touch (for revert on cancel)
    if (!this.activeFiles.has(relativePath)) {
      this.activeFiles.set(relativePath, {
        originalContent: editor.document.getText(),
        uri: fileUri
      });
    }

    // Replace entire document content with the streamed-so-far content
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(fileUri, fullRange, content);
    await vscode.workspace.applyEdit(edit);

    // Scroll to bottom so user sees the newest lines
    const lastLine = Math.max(0, editor.document.lineCount - 1);
    editor.revealRange(
      new vscode.Range(lastLine, 0, lastLine, 0),
      vscode.TextEditorRevealType.Default
    );
  }

  /**
   * Revert all streamed files to their original content.
   * Called when the agent is cancelled mid-stream.
   */
  async revertAll(): Promise<void> {
    for (const [, { originalContent, uri }] of this.activeFiles) {
      try {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (!doc) continue;

        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, fullRange, originalContent);
        await vscode.workspace.applyEdit(edit);
      } catch { /* file may have been closed */ }
    }
    this.activeFiles.clear();
  }

  /** Whether any files have been streamed into. */
  hasStreamed(): boolean {
    return this.activeFiles.size > 0;
  }

  /** Clear tracking state. Call after tool execution writes the real files. */
  reset(): void {
    this.activeFiles.clear();
  }

  /** Clean up resources. */
  dispose(): void {
    this.activeFiles.clear();
  }
}
