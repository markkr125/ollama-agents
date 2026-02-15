import * as vscode from 'vscode';
import { AgentChatExecutor } from '../../services/agent/agentChatExecutor';
import { PendingEditReviewService } from '../../services/review/pendingEditReviewService';
import { ChatSessionController } from '../chatSessionController';
import { IMessageHandler, WebviewMessageEmitter } from '../chatTypes';

/**
 * Handles file-change widget messages: diff viewing, keep/undo operations.
 */
export class FileChangeMessageHandler implements IMessageHandler {
  readonly handledTypes = [
    'openFileChangeDiff', 'openFileChangeReview', 'requestFilesDiffStats',
    'keepFile', 'undoFile', 'keepAllChanges', 'undoAllChanges',
    'openWorkspaceFile', 'revealInExplorer', 'viewAllEdits'
  ] as const;

  constructor(
    private readonly emitter: WebviewMessageEmitter,
    private readonly sessionController: ChatSessionController,
    private readonly agentExecutor: AgentChatExecutor,
    private readonly reviewService?: PendingEditReviewService
  ) {}

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'openFileChangeDiff':
        await this.agentExecutor.openSnapshotDiff(data.checkpointId, data.filePath, this.sessionController.getCurrentSessionId());
        break;
      case 'openFileChangeReview':
        if (this.reviewService) {
          await this.reviewService.openFileReview(data.checkpointId, data.filePath, this.sessionController.getCurrentSessionId());
          const pos = this.reviewService.getChangePosition(data.checkpointId);
          if (pos) {
            this.emitter.postMessage({ type: 'reviewChangePosition', checkpointId: data.checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
          }
        } else {
          await this.agentExecutor.openSnapshotDiff(data.checkpointId, data.filePath, this.sessionController.getCurrentSessionId());
        }
        break;
      case 'requestFilesDiffStats':
        await this.handleRequestFilesDiffStats(data.checkpointId);
        break;
      case 'keepFile':
        await this.handleKeepFile(data.checkpointId, data.filePath, data.sessionId);
        break;
      case 'undoFile':
        await this.handleUndoFile(data.checkpointId, data.filePath, data.sessionId);
        break;
      case 'keepAllChanges':
        await this.handleKeepAllChanges(data.checkpointId, data.sessionId);
        break;
      case 'undoAllChanges':
        await this.handleUndoAllChanges(data.checkpointId, data.sessionId);
        break;
      case 'openWorkspaceFile':
        await this.handleOpenWorkspaceFile(data.path, data.line);
        break;
      case 'revealInExplorer':
        await this.handleRevealInExplorer(data.path);
        break;
      case 'viewAllEdits':
        await this.handleViewAllEdits(data.checkpointIds);
        break;
    }
  }

  private async handleRequestFilesDiffStats(checkpointId: string) {
    if (!checkpointId) return;
    try {
      const stats = await this.agentExecutor.computeFilesDiffStats(checkpointId);
      this.emitter.postMessage({ type: 'filesDiffStats', checkpointId, files: stats });
    } catch (err: any) {
      console.warn('[FileChangeHandler] Failed to compute diff stats:', err);
    }
    // Build review session if needed so "Change X of Y" counter is populated
    if (this.reviewService) {
      try {
        await this.reviewService.startReviewForCheckpoint(checkpointId);
        const pos = this.reviewService.getChangePosition(checkpointId);
        if (pos) {
          this.emitter.postMessage({ type: 'reviewChangePosition', checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
        }
      } catch { /* non-critical — navigation still works on click */ }
    }
  }

  private async handleKeepFile(checkpointId: string, filePath: string, sessionId?: string) {
    if (!checkpointId || !filePath) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    let success = false;
    try {
      const result = await this.agentExecutor.keepFile(checkpointId, filePath);
      success = result.success;
      this.reviewService?.removeFileFromReview(filePath);
    } catch (err: any) {
      console.warn('[FileChangeHandler] keepFile failed:', err);
    }
    const payload = { checkpointId, filePath, action: 'kept', success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'fileChangeResult', payload);
    this.emitter.postMessage({ type: 'fileChangeResult', ...payload, sessionId: resolvedSessionId });
    this.sendReviewPosition(checkpointId);
    await this.sessionController.sendSessionsList();
  }

  private async handleUndoFile(checkpointId: string, filePath: string, sessionId?: string) {
    if (!checkpointId || !filePath) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    let success = false;
    try {
      const result = await this.agentExecutor.undoFile(checkpointId, filePath);
      success = result.success;
      this.reviewService?.removeFileFromReview(filePath);
    } catch (err: any) {
      console.warn('[FileChangeHandler] undoFile failed:', err);
    }
    const payload = { checkpointId, filePath, action: 'undone', success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'fileChangeResult', payload);
    this.emitter.postMessage({ type: 'fileChangeResult', ...payload, sessionId: resolvedSessionId });
    this.sendReviewPosition(checkpointId);
    await this.sessionController.sendSessionsList();
  }

  private async handleKeepAllChanges(checkpointId: string, sessionId?: string) {
    if (!checkpointId) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    let success = false;
    try {
      const result = await this.agentExecutor.keepAllChanges(checkpointId);
      success = result.success;
      this.reviewService?.closeReview();
    } catch (err: any) {
      console.warn('[FileChangeHandler] keepAllChanges failed:', err);
    }
    const payload = { checkpointId, action: 'kept', success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'keepUndoResult', payload);
    this.emitter.postMessage({ type: 'keepUndoResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleUndoAllChanges(checkpointId: string, sessionId?: string) {
    if (!checkpointId) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    let success = false;
    let errors: string[] | undefined;
    try {
      const result = await this.agentExecutor.undoAllChanges(checkpointId);
      success = result.success;
      errors = result.errors;
      this.reviewService?.closeReview();
    } catch (err: any) {
      console.warn('[FileChangeHandler] undoAllChanges failed:', err);
    }
    const payload = { checkpointId, action: 'undone', success, errors };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'keepUndoResult', payload);
    this.emitter.postMessage({ type: 'keepUndoResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  /**
   * Send updated review change position to the webview after a file is
   * removed from review (keep/undo). Ensures the "Change X of Y" counter
   * reflects the reduced hunk count immediately.
   */
  private sendReviewPosition(checkpointId: string): void {
    if (!this.reviewService) return;
    const pos = this.reviewService.getChangePosition(checkpointId);
    if (pos) {
      this.emitter.postMessage({
        type: 'reviewChangePosition',
        checkpointId,
        current: pos.current,
        total: pos.total,
        filePath: pos.filePath
      });
    }
  }

  private async handleViewAllEdits(checkpointIds: string[]) {
    if (!checkpointIds?.length) return;
    try {
      await this.agentExecutor.openAllEdits(checkpointIds);
    } catch (err: any) {
      console.warn('[FileChangeHandler] Failed to open all edits:', err);
    }
  }

  private async handleOpenWorkspaceFile(relativePath: string, line?: number) {
    if (!relativePath) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return;
    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const options: vscode.TextDocumentShowOptions = { preview: true };
      if (typeof line === 'number' && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err: any) {
      console.warn('[FileChangeHandler] Failed to open file:', relativePath, err);
    }
  }

  private async handleRevealInExplorer(relativePath: string) {
    if (!relativePath) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return;
    const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
    try {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch (err: any) {
      console.warn('[FileChangeHandler] Failed to reveal in explorer:', relativePath, err);
    }
  }
}
