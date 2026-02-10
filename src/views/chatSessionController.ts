import { DatabaseService } from '../services/databaseService';
import { ChatSessionStatus, MessageRecord, SessionRecord } from '../types/session';
import { ChatMessage, WebviewMessageEmitter } from './chatTypes';
import { getToolActionInfo, getToolSuccessInfo } from './toolUIFormatter';

export class ChatSessionController {
  private currentSessionId: string = '';
  private currentSession: SessionRecord | null = null;
  private currentMessages: MessageRecord[] = [];
  private loadRequestId = 0;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly emitter: WebviewMessageEmitter,
    private readonly isSessionActive: (sessionId: string) => boolean
  ) {}

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  getCurrentMessages(): MessageRecord[] {
    return this.currentMessages;
  }

  async getCurrentSession(): Promise<SessionRecord | null> {
    if (this.currentSession && this.currentSession.id === this.currentSessionId) {
      return this.currentSession;
    }
    if (this.currentSessionId) {
      this.currentSession = await this.databaseService.getSession(this.currentSessionId);
      return this.currentSession;
    }
    return null;
  }

  pushMessage(message: MessageRecord) {
    this.currentMessages.push(message);
  }

  async createNewSession(mode: string, model: string): Promise<string> {
    const session = await this.databaseService.createSession('New Chat', mode, model);
    this.currentSessionId = session.id;
    this.currentSession = session;
    this.currentMessages = [];
    return session.id;
  }

  async sendSessionsList(offset = 0, append = false) {
    const sessionsPage = await this.databaseService.listSessions(50, offset);
    const pendingStats = await this.databaseService.getSessionsPendingStats();

    const sessionsList = sessionsPage.sessions.map(s => {
      const stats = pendingStats.get(s.id);
      return {
        id: s.id,
        title: s.title,
        timestamp: s.updated_at,
        active: s.id === this.currentSessionId,
        status: s.status,
        ...(stats && stats.fileCount > 0 ? {
          pendingAdditions: stats.additions,
          pendingDeletions: stats.deletions,
          pendingFileCount: stats.fileCount
        } : {})
      };
    });

    this.emitter.postMessage({
      type: append ? 'appendSessions' : 'loadSessions',
      sessions: sessionsList,
      hasMore: sessionsPage.hasMore,
      nextOffset: sessionsPage.nextOffset
    });
  }

  async setSessionStatus(status: ChatSessionStatus, sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) return;
    await this.databaseService.updateSessionStatus(targetSessionId, status);
    if (this.currentSession && this.currentSession.id === targetSessionId) {
      this.currentSession = { ...this.currentSession, status, updated_at: Date.now() };
    }
    this.emitter.postMessage({
      type: 'updateSessionStatus',
      sessionId: targetSessionId,
      status
    });
  }

  async loadSession(sessionId: string) {
    const requestId = ++this.loadRequestId;
    const session = await this.databaseService.getSession(sessionId);
    if (!this.isLatestRequest(requestId)) {
      return;
    }
    if (!session) {
      this.emitter.postMessage({ type: 'clearMessages', sessionId });
      await this.sendSessionsList();
      return;
    }

    let messages: MessageRecord[] = [];
    try {
      messages = await this.databaseService.getSessionMessages(sessionId);
    } catch (error: any) {
      if (!this.isLatestRequest(requestId)) {
        return;
      }
      await this.handleLoadSessionError(sessionId, error);
      return;
    }

    if (!this.isLatestRequest(requestId)) {
      return;
    }

    this.currentSessionId = sessionId;
    this.currentSession = session;
    this.currentMessages = messages;

    // Debug: Log message order before sending to UI
    console.log('[loadSession] Message order:', messages.map(m => ({
      id: m.id.substring(0, 8),
      role: m.role,
      timestamp: m.timestamp,
      tool: m.tool_name || '-'
    })));

    const chatMessages: ChatMessage[] = messages.map(m => {
      let actionText: string | undefined;
      let actionDetail: string | undefined;
      let actionIcon: string | undefined;
      let actionStatus: 'success' | 'error' | undefined;
      let toolArgs: any = undefined;

      if (m.tool_input) {
        try {
          toolArgs = JSON.parse(m.tool_input);
        } catch (error) {
          console.debug('Failed to parse tool input JSON:', error);
          toolArgs = undefined;
        }
      }

      if (m.role === 'tool' && m.tool_name) {
        const isError = (m.content || '').startsWith('Error:') || (m.tool_output || '').startsWith('Error:');
        actionStatus = isError ? 'error' : 'success';

        const { actionText: baseText, actionDetail: baseDetail, actionIcon: baseIcon } =
          getToolActionInfo(m.tool_name, toolArgs);

        actionText = baseText;
        actionIcon = baseIcon;
        actionDetail = baseDetail;

        if (!isError) {
          const { actionText: successText, actionDetail: successDetail } =
            getToolSuccessInfo(m.tool_name, toolArgs, m.tool_output || m.content || '');
          actionText = successText || actionText;
          actionDetail = successDetail || actionDetail;
        } else {
          actionDetail = (m.content || '').replace(/^Error:\s*/, '') || actionDetail;
        }
      }

      return {
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolName: m.tool_name,
        toolInput: m.tool_input,
        toolOutput: m.tool_output,
        progressTitle: m.progress_title,
        actionText,
        actionDetail,
        actionIcon,
        actionStatus,
        model: m.model
      };
    });

    this.emitter.postMessage({
      type: 'loadSessionMessages',
      messages: chatMessages,
      sessionId,
      autoApproveCommands: !!session.auto_approve_commands,
      autoApproveSensitiveEdits: !!session.auto_approve_sensitive_edits,
      sessionSensitiveFilePatterns: session.sensitive_file_patterns ?? null
    });

    if (session.status === 'generating' && this.isSessionActive(sessionId)) {
      this.emitter.postMessage({ type: 'generationStarted', sessionId });
    } else {
      this.emitter.postMessage({ type: 'generationStopped', sessionId });
    }
  }

  private isLatestRequest(requestId: number): boolean {
    return requestId === this.loadRequestId;
  }

  private async handleLoadSessionError(sessionId: string, error: any): Promise<void> {
    this.emitter.postMessage({
      type: 'showError',
      message: error?.message || 'Failed to load session.',
      sessionId
    });
    this.emitter.postMessage({ type: 'clearMessages', sessionId });
    await this.sendSessionsList();
  }

  async deleteSession(sessionId: string, mode: string, model: string) {
    await this.databaseService.deleteSession(sessionId);
    if (sessionId === this.currentSessionId) {
      await this.createNewSession(mode, model);
      this.emitter.postMessage({ type: 'clearMessages', sessionId: this.currentSessionId });
      await this.sendSessionsList();
    } else {
      this.emitter.postMessage({ type: 'sessionDeleted', sessionId });
    }
  }

  async deleteMultipleSessions(sessionIds: string[], mode: string, model: string) {
    const total = sessionIds.length;
    const needsNewSession = sessionIds.includes(this.currentSessionId);

    await this.databaseService.deleteMultipleSessions(
      sessionIds,
      total >= 10 ? (completed, t) => {
        this.emitter.postMessage({ type: 'deletionProgress', completed, total: t });
      } : undefined
    );

    if (needsNewSession) {
      await this.createNewSession(mode, model);
      this.emitter.postMessage({ type: 'clearMessages', sessionId: this.currentSessionId });
    }

    this.emitter.postMessage({ type: 'sessionsDeleted', sessionIds });
    await this.sendSessionsList();
  }

  async updateSessionAutoApprove(sessionId: string, enabled: boolean): Promise<void> {
    if (this.currentSession && this.currentSession.id === sessionId) {
      this.currentSession = { ...this.currentSession, auto_approve_commands: enabled, updated_at: Date.now() };
    }
  }

  async updateSessionAutoApproveSensitiveEdits(sessionId: string, enabled: boolean): Promise<void> {
    if (this.currentSession && this.currentSession.id === sessionId) {
      this.currentSession = { ...this.currentSession, auto_approve_sensitive_edits: enabled, updated_at: Date.now() };
    }
  }

  async updateSessionSensitiveFilePatterns(sessionId: string, patterns: string | null): Promise<void> {
    if (this.currentSession && this.currentSession.id === sessionId) {
      this.currentSession = { ...this.currentSession, sensitive_file_patterns: patterns, updated_at: Date.now() };
    }
  }

  async handleSearchSessions(query: string) {
    if (!query.trim()) {
      await this.sendSessionsList();
      return;
    }

    try {
      const results = await this.databaseService.searchHybrid(query, 50);

      const groupedResults: Map<string, {
        session: { id: string; title: string; timestamp: number };
        messages: Array<{ id: string; content: string; snippet: string; role: string }>;
      }> = new Map();

      for (const result of results) {
        if (result.message.role === 'tool') {
          continue;
        }
        if (!groupedResults.has(result.session.id)) {
          groupedResults.set(result.session.id, {
            session: {
              id: result.session.id,
              title: result.session.title,
              timestamp: result.session.updated_at
            },
            messages: []
          });
        }
        groupedResults.get(result.session.id)!.messages.push({
          id: result.message.id,
          content: result.message.content,
          snippet: result.snippet,
          role: result.message.role
        });
      }

      this.emitter.postMessage({
        type: 'searchSessionsResult',
        results: Array.from(groupedResults.values()),
        query
      });
    } catch (error) {
      console.error('Search failed:', error);
      this.emitter.postMessage({
        type: 'searchSessionsResult',
        results: [],
        query,
        error: 'Search failed'
      });
    }
  }
}
