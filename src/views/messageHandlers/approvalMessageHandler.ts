import { AgentChatExecutor } from '../../agent/execution/orchestration/agentChatExecutor';
import { DatabaseService } from '../../services/database/databaseService';
import { ChatSessionController } from '../chatSessionController';
import { IMessageHandler, WebviewMessageEmitter } from '../chatTypes';

/**
 * Handles tool-approval and auto-approve toggle messages.
 */
export class ApprovalMessageHandler implements IMessageHandler {
  readonly handledTypes = [
    'toolApprovalResponse', 'setAutoApprove', 'setAutoApproveSensitiveEdits',
    'updateSessionSensitivePatterns', 'openFileDiff'
  ] as const;

  constructor(
    private readonly emitter: WebviewMessageEmitter,
    private readonly sessionController: ChatSessionController,
    private readonly agentExecutor: AgentChatExecutor,
    private readonly databaseService: DatabaseService
  ) {}

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'toolApprovalResponse':
        this.agentExecutor.handleToolApprovalResponse(data.approvalId, !!data.approved, data.command);
        break;
      case 'setAutoApprove':
        await this.handleSetAutoApprove(data.sessionId, !!data.enabled);
        break;
      case 'setAutoApproveSensitiveEdits':
        await this.handleSetAutoApproveSensitiveEdits(data.sessionId, !!data.enabled);
        break;
      case 'updateSessionSensitivePatterns':
        await this.handleUpdateSessionSensitivePatterns(data.sessionId, data.patterns);
        break;
      case 'openFileDiff':
        await this.agentExecutor.openFileDiff(data.approvalId);
        break;
    }
  }

  private async handleSetAutoApprove(sessionId: string, enabled: boolean) {
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { auto_approve_commands: enabled });
    await this.sessionController.updateSessionAutoApprove(sessionId, enabled);
    this.emitter.postMessage({
      type: 'sessionApprovalSettings',
      sessionId,
      autoApproveCommands: enabled
    });
  }

  private async handleSetAutoApproveSensitiveEdits(sessionId: string, enabled: boolean) {
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { auto_approve_sensitive_edits: enabled });
    await this.sessionController.updateSessionAutoApproveSensitiveEdits(sessionId, enabled);
    this.emitter.postMessage({
      type: 'sessionApprovalSettings',
      sessionId,
      autoApproveSensitiveEdits: enabled
    });
  }

  private async handleUpdateSessionSensitivePatterns(sessionId: string, patterns: string | null) {
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { sensitive_file_patterns: patterns });
    await this.sessionController.updateSessionSensitiveFilePatterns(sessionId, patterns);
    this.emitter.postMessage({
      type: 'sessionApprovalSettings',
      sessionId,
      sessionSensitiveFilePatterns: patterns
    });
  }
}
