import * as vscode from 'vscode';
import { DatabaseService } from '../database/databaseService';

/**
 * Provides original file content from checkpoint snapshots for the multi-diff editor.
 * Registered on the 'ollama-original' URI scheme.
 *
 * URI format: ollama-original:/absolute/path/to/file.ts?ckpt=<checkpointId>&rel=<workspace-relative-path>
 *
 * The URI path mirrors the absolute disk path so that VS Code's multi-diff
 * editor shows matching directory labels on both sides. The `rel` query
 * param carries the workspace-relative path used for DB lookup.
 */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly databaseService: DatabaseService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const checkpointId = params.get('ckpt');
    const relPath = params.get('rel');
    if (!checkpointId || !relPath) return '';

    try {
      const snapshot = await this.databaseService.getSnapshotForFile(checkpointId, relPath);
      return snapshot?.original_content ?? '';
    } catch {
      return '';
    }
  }
}
