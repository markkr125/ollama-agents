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
    'keepFile', 'undoFile', 'keepAllChanges', 'undoAllChanges'
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
    const result = await this.agentExecutor.keepFile(checkpointId, filePath);
    this.reviewService?.removeFileFromReview(filePath);
    const payload = { checkpointId, filePath, action: 'kept', success: result.success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'fileChangeResult', payload);
    this.emitter.postMessage({ type: 'fileChangeResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleUndoFile(checkpointId: string, filePath: string, sessionId?: string) {
    if (!checkpointId || !filePath) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.undoFile(checkpointId, filePath);
    this.reviewService?.removeFileFromReview(filePath);
    const payload = { checkpointId, filePath, action: 'undone', success: result.success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'fileChangeResult', payload);
    this.emitter.postMessage({ type: 'fileChangeResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleKeepAllChanges(checkpointId: string, sessionId?: string) {
    if (!checkpointId) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.keepAllChanges(checkpointId);
    this.reviewService?.closeReview();
    const payload = { checkpointId, action: 'kept', success: result.success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'keepUndoResult', payload);
    this.emitter.postMessage({ type: 'keepUndoResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleUndoAllChanges(checkpointId: string, sessionId?: string) {
    if (!checkpointId) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.undoAllChanges(checkpointId);
    this.reviewService?.closeReview();
    const payload = { checkpointId, action: 'undone', success: result.success, errors: result.errors };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'keepUndoResult', payload);
    this.emitter.postMessage({ type: 'keepUndoResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }
}
