/**
 * Tracks the active text editor and selection, sending `editorContext`
 * messages to the webview so it can show implicit file / selection chips.
 *
 * Listens to:
 *  - `onDidChangeActiveTextEditor`  (file chip)
 *  - `onDidChangeTextEditorSelection` (selection chip, debounced)
 *  - `onDidChangeVisibility` on the webview panel (resend on focus)
 */
import * as vscode from 'vscode';
import { WebviewMessageEmitter } from './chatTypes';

export interface EditorContextPayload {
  type: 'editorContext';
  activeFile: { fileName: string; filePath: string; relativePath: string; languageId: string } | null;
  activeSelection: {
    fileName: string;
    relativePath: string;
    content: string;
    startLine: number;
    endLine: number;
    languageId: string;
  } | null;
}

export class EditorContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SELECTION_DEBOUNCE_MS = 500;

  constructor(private readonly emitter: WebviewMessageEmitter) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.send()),
      vscode.window.onDidChangeTextEditorSelection(() => this.debouncedSend()),
    );
  }

  /** Call once from `onDidChangeVisibility` when the webview becomes visible. */
  sendNow(): void {
    this.send();
  }

  dispose(): void {
    if (this.selectionTimer) {
      clearTimeout(this.selectionTimer);
    }
    for (const d of this.disposables) d.dispose();
  }

  // --- private ---

  private debouncedSend(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.send();
    }, EditorContextTracker.SELECTION_DEBOUNCE_MS);
  }

  private send(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.emitter.postMessage({ type: 'editorContext', activeFile: null, activeSelection: null });
      return;
    }

    const doc = editor.document;
    // Skip non-file URIs (output panels, settings, etc.)
    if (doc.uri.scheme !== 'file') {
      this.emitter.postMessage({ type: 'editorContext', activeFile: null, activeSelection: null });
      return;
    }

    const fileName = doc.fileName.split('/').pop() || doc.fileName;
    // Build workspace-relative path (with folder prefix in multi-root)
    const relativePath = vscode.workspace.asRelativePath(doc.uri, true);
    const activeFile = {
      fileName,
      filePath: doc.uri.fsPath,
      relativePath,
      languageId: doc.languageId,
    };

    let activeSelection: EditorContextPayload['activeSelection'] = null;
    const sel = editor.selection;
    if (!sel.isEmpty) {
      const text = doc.getText(sel);
      if (text.trim().length > 0) {
        activeSelection = {
          fileName,
          relativePath,
          content: text.substring(0, 8000),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          languageId: doc.languageId,
        };
      }
    }

    this.emitter.postMessage({ type: 'editorContext', activeFile, activeSelection });
  }
}
