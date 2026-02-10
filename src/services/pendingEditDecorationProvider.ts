import * as vscode from 'vscode';

/**
 * FileDecorationProvider that marks files with pending AI edits.
 * Shows a ● badge and colors the file name in Explorer/tabs.
 */
export class PendingEditDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private pendingUris = new Set<string>();

  markPending(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.pendingUris.has(key)) return;
    this.pendingUris.add(key);
    this._onDidChange.fire(uri);
  }

  clearPending(uri: vscode.Uri): void {
    const key = uri.toString();
    if (!this.pendingUris.delete(key)) return;
    this._onDidChange.fire(uri);
  }

  clearAll(): void {
    const uris = [...this.pendingUris].map(s => vscode.Uri.parse(s));
    this.pendingUris.clear();
    if (uris.length > 0) {
      this._onDidChange.fire(uris);
    }
  }

  hasPending(): boolean {
    return this.pendingUris.size > 0;
  }

  getPendingCount(): number {
    return this.pendingUris.size;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.pendingUris.has(uri.toString())) return undefined;
    return new vscode.FileDecoration(
      '●',
      'Pending AI edit — review before accepting',
      new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
    );
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
