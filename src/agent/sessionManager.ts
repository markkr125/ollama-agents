import * as vscode from 'vscode';
import { Session } from '../types/session';

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private maxSessions = 10;

  constructor(private context: vscode.ExtensionContext) {
    this.loadSessions();
  }

  /**
   * Create a new session
   */
  createSession(
    task: string,
    model: string,
    workspace?: vscode.WorkspaceFolder
  ): Session {
    const session: Session = {
      id: this.generateId(),
      task,
      model,
      status: 'executing',
      branch: undefined,
      filesChanged: [],
      toolCalls: [],
      errors: [],
      workspace: workspace || undefined,
      startTime: Date.now()
    };

    this.sessions.set(session.id, session);
    this.checkSessionLimit();
    this.saveSessions();

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): Session[] {
    return this.getAllSessions().filter(s => s.status === 'executing' || s.status === 'planned');
  }

  /**
   * Update session
   */
  updateSession(id: string, updates: Partial<Session>): void {
    const session = this.sessions.get(id);
    if (!session) {return;}

    Object.assign(session, updates);
    
    if (updates.status && updates.status !== 'executing' && updates.status !== 'planned') {
      session.endTime = Date.now();
    }

    this.saveSessions();
  }

  /**
   * Delete session
   */
  deleteSession(id: string): void {
    this.sessions.delete(id);
    this.saveSessions();
  }

  /**
   * Clear completed sessions
   */
  clearCompleted(): void {
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'completed') {
        this.sessions.delete(id);
      }
    }
    this.saveSessions();
  }

  /**
   * Get session summary
   */
  getSessionSummary(id: string): string {
    const session = this.sessions.get(id);
    if (!session) {
      return 'Session not found';
    }

    const lines = [
      `Task: ${session.task}`,
      `Model: ${session.model}`,
      `Status: ${session.status}`,
      `Branch: ${session.branch || 'N/A'}`,
      `Files changed: ${session.filesChanged.length}`,
      `Tool calls: ${session.toolCalls.length}`,
      `Errors: ${session.errors.length}`
    ];

    if (session.endTime) {
      const duration = Math.round((session.endTime - session.startTime) / 1000);
      lines.push(`Duration: ${duration}s`);
    }

    return lines.join('\n');
  }

  /**
   * Check session limit and warn
   */
  private checkSessionLimit(): void {
    if (this.sessions.size > this.maxSessions) {
      // vscode.window.showWarningMessage(
      //   `⚠️ You have ${this.sessions.size} active sessions. Consider cleaning up old sessions to free memory.`,
      //   'Clear Completed'
      // ).then(choice => {
      //   if (choice === 'Clear Completed') {
      //     this.clearCompleted();
      //     vscode.window.showInformationMessage('Completed sessions cleared');
      //   }
      // });
    }
  }

  /**
   * Generate unique session ID
   */
  private generateId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Load sessions from storage
   */
  private loadSessions(): void {
    const stored = this.context.workspaceState.get<string>('ollamaCopilot.sessions');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        this.sessions = new Map(parsed);
      } catch (error) {
        console.error('Failed to load sessions:', error);
      }
    }
  }

  /**
   * Save sessions to storage
   */
  private saveSessions(): void {
    const serialized = JSON.stringify(Array.from(this.sessions.entries()));
    this.context.workspaceState.update('ollamaCopilot.sessions', serialized);
  }
}
