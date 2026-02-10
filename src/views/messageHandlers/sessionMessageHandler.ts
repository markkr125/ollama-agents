import * as vscode from 'vscode';
import { ChatSessionController } from '../chatSessionController';
import { IMessageHandler, ViewState, WebviewMessageEmitter } from '../chatTypes';

/**
 * Handles session list management messages: load, delete, search, pagination.
 */
export class SessionMessageHandler implements IMessageHandler {
  readonly handledTypes = [
    'loadSession', 'deleteSession', 'deleteMultipleSessions', 'searchSessions', 'loadMoreSessions'
  ] as const;

  constructor(
    private readonly state: ViewState,
    private readonly emitter: WebviewMessageEmitter,
    private readonly sessionController: ChatSessionController
  ) {}

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'loadSession':
        await this.sessionController.loadSession(data.sessionId);
        break;
      case 'deleteSession':
        await this.sessionController.deleteSession(data.sessionId, this.state.currentMode, this.state.currentModel);
        break;
      case 'deleteMultipleSessions': {
        const ids: string[] = data.sessionIds || [];
        if (ids.length === 0) break;
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${ids.length} conversation${ids.length > 1 ? 's' : ''}? This cannot be undone.`,
          { modal: true },
          'Delete'
        );
        if (confirm === 'Delete') {
          await this.sessionController.deleteMultipleSessions(ids, this.state.currentMode, this.state.currentModel);
        } else {
          // Cancelled — tell frontend to undo optimistic removal
          this.emitter.postMessage({ type: 'sessionsDeleted', sessionIds: [] });
          await this.sessionController.sendSessionsList();
        }
        break;
      }
      case 'searchSessions':
        await this.sessionController.handleSearchSessions(data.query);
        break;
      case 'loadMoreSessions':
        await this.sessionController.sendSessionsList(data.offset, true);
        break;
    }
  }
}
