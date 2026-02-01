import { DatabaseService } from '../services/databaseService';
import { ChatSessionStatus, MessageRecord, SessionRecord } from '../types/session';
import { ChatMessage, WebviewMessageEmitter } from './chatTypes';
import { getToolActionInfo, getToolSuccessInfo } from './toolUIFormatter';

export class ChatSessionController {
  private currentSessionId: string = '';
  private currentSession: SessionRecord | null = null;
  private currentMessages: MessageRecord[] = [];

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
    const sessionsList = sessionsPage.sessions.map(s => ({
      id: s.id,
      title: s.title,
      timestamp: s.updated_at,
      active: s.id === this.currentSessionId,
      status: s.status
    }));

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
    const session = await this.databaseService.getSession(sessionId);
    if (!session) {
      this.emitter.postMessage({ type: 'clearMessages', sessionId });
      await this.sendSessionsList();
      return;
    }

    this.currentSessionId = sessionId;
    this.currentSession = session;
    try {
      this.currentMessages = await this.databaseService.getSessionMessages(sessionId);
    } catch (error: any) {
      this.emitter.postMessage({
        type: 'showError',
        message: error.message || 'Failed to load session.',
        sessionId
      });
      this.emitter.postMessage({ type: 'clearMessages' });
      await this.sendSessionsList();
      return;
    }

    const messages: ChatMessage[] = this.currentMessages.map(m => {
      let actionText: string | undefined;
      let actionDetail: string | undefined;
      let actionIcon: string | undefined;
      let actionStatus: 'success' | 'error' | undefined;
      let toolArgs: any = undefined;

      if (m.tool_input) {
        try {
          toolArgs = JSON.parse(m.tool_input);
        } catch {
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
      messages,
      sessionId
    });

    if (session.status === 'generating' && this.isSessionActive(sessionId)) {
      this.emitter.postMessage({ type: 'generationStarted', sessionId });
    } else {
      this.emitter.postMessage({ type: 'generationStopped', sessionId });
    }

    await this.sendSessionsList();
  }

  async deleteSession(sessionId: string, mode: string, model: string) {
    await this.databaseService.deleteSession(sessionId);
    if (sessionId === this.currentSessionId) {
      await this.createNewSession(mode, model);
      this.emitter.postMessage({ type: 'clearMessages', sessionId: this.currentSessionId });
    }
    await this.sendSessionsList();
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
