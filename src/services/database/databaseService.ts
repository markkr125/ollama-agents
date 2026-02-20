import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { Model } from '../../types/ollama';
import { ChatSessionStatus, MessageRecord, SessionRecord, SessionsPage } from '../../types/session';
import { OllamaClient } from '../model/ollamaClient';
import { LanceSearchService, SearchResult } from './lanceSearchService';
import { SessionIndexService } from './sessionIndexService';
import { migrateIfNeeded, resolveStoragePath } from './storagePath';

// Re-export SearchResult so existing consumers keep working
export type { SearchResult } from './lanceSearchService';

const generateId = (): string => {
  try {
    if (typeof randomUUID === 'function') {
      return randomUUID();
    }
  } catch {
    // fall through to fallback
  }

  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// ============================================================================
// Database Service
// ============================================================================

/**
 * DatabaseService is a facade that:
 * - Delegates all session & message CRUD to SessionIndexService (SQLite).
 * - Delegates search (FTS + vector + RRF reranking) to LanceSearchService.
 * - Provides fire-and-forget indexMessage() for search indexing.
 */
export class DatabaseService {
  // SQLite (primary storage, eager-loaded)
  private sessionIndex: SessionIndexService;
  // LanceDB (search-only, lazy-loaded)
  private lanceSearch: LanceSearchService;

  private context: vscode.ExtensionContext;
  private readonly storageUri: vscode.Uri;
  private ollamaClient: OllamaClient | null = null;
  private initialized = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.storageUri = resolveStoragePath(context);
    this.sessionIndex = new SessionIndexService(this.storageUri);

    const dbPath = vscode.Uri.joinPath(this.storageUri, 'ollama-copilot.lance').fsPath;
    this.lanceSearch = new LanceSearchService(dbPath, id => this.getSession(id));
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(ollamaClient?: OllamaClient): Promise<void> {
    if (this.initialized) return;

    this.ollamaClient = ollamaClient || null;

    // Ensure storage directory exists
    await vscode.workspace.fs.createDirectory(this.storageUri);

    // Migrate databases from old context.storageUri if needed (one-time, silent)
    await migrateIfNeeded(this.context, this.storageUri);

    // Eagerly init SQLite (fast, native)
    await this.sessionIndex.initialize();

    // Kick off LanceDB in background
    this.lanceSearch.startInit();

    this.initialized = true;
    console.log(`DatabaseService initialized at ${this.storageUri.fsPath} (SQLite ready, LanceDB loading in background)`);
  }

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error('DatabaseService not initialized');
    }
  }

  // --------------------------------------------------------------------------
  // Session CRUD (delegates to SQLite)
  // --------------------------------------------------------------------------

  async createSession(
    title: string,
    mode: string,
    model: string
  ): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: generateId(),
      title,
      mode,
      model,
      status: 'idle',
      auto_approve_commands: false,
      auto_approve_sensitive_edits: false,
      sensitive_file_patterns: null,
      created_at: Date.now(),
      updated_at: Date.now()
    };

    await this.sessionIndex.createSession(session);
    return session;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessionIndex.getSession(id);
  }

  async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
    await this.sessionIndex.updateSession(id, updates);
  }

  async updateSessionStatus(id: string, status: ChatSessionStatus): Promise<void> {
    await this.sessionIndex.updateSession(id, { status });
  }

  async deleteSession(id: string): Promise<void> {
    // SQLite CASCADE handles messages deletion
    await this.sessionIndex.deleteSession(id);

    // Best-effort cleanup LanceDB search index
    await this.lanceSearch.deleteSessionEntries(id);
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    return this.sessionIndex.listSessions(limit, offset);
  }

  async saveSessionMemory(sessionId: string, memoryJson: string): Promise<void> {
    return this.sessionIndex.saveSessionMemory(sessionId, memoryJson);
  }

  async loadSessionMemory(sessionId: string): Promise<string | null> {
    return this.sessionIndex.loadSessionMemory(sessionId);
  }

  async resetGeneratingSessions(status: ChatSessionStatus = 'idle'): Promise<void> {
    await this.sessionIndex.resetGeneratingSessions(status);
  }

  async findIdleEmptySession(): Promise<string | null> {
    return this.sessionIndex.findIdleEmptySession();
  }

  async deleteMultipleSessions(
    ids: string[],
    onProgress?: (completed: number, total: number) => void
  ): Promise<void> {
    // SQLite: batch delete in single transaction (CASCADE handles messages)
    await this.sessionIndex.deleteMultipleSessions(ids);

    // Best-effort LanceDB cleanup
    await this.lanceSearch.deleteMultipleSessionEntries(ids);

    if (onProgress) {
      onProgress(ids.length, ids.length);
    }
  }

  // --------------------------------------------------------------------------
  // Model cache (delegates to SQLite)
  // --------------------------------------------------------------------------

  async upsertModels(models: Model[]): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.upsertModels(models);
  }

  async getCachedModels(): Promise<Model[]> {
    this.ensureReady();
    return this.sessionIndex.getCachedModels();
  }

  async setModelEnabled(name: string, enabled: boolean): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.setModelEnabled(name, enabled);
  }

  async setModelMaxContext(name: string, maxContext: number | null): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.setModelMaxContext(name, maxContext);
  }

  // --------------------------------------------------------------------------
  // Message CRUD (delegates to SQLite, fire-and-forget LanceDB indexing)
  // --------------------------------------------------------------------------

  async addMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    options: {
      model?: string;
      toolName?: string;
      toolInput?: string;
      toolOutput?: string;
      progressTitle?: string;
      toolCalls?: string;
    } = {}
  ): Promise<MessageRecord> {
    this.ensureReady();

    const message: MessageRecord = {
      id: generateId(),
      session_id: sessionId,
      role,
      content,
      model: options.model,
      tool_name: options.toolName,
      tool_input: options.toolInput,
      tool_output: options.toolOutput,
      progress_title: options.progressTitle,
      tool_calls: options.toolCalls,
      timestamp: await this.sessionIndex.getNextTimestamp(sessionId)
    };

    // Primary storage: SQLite (indexed, fast)
    await this.sessionIndex.addMessage(message);

    // Update session's updated_at
    await this.sessionIndex.updateSession(sessionId, {});

    // Fire-and-forget: index in LanceDB for search
    this.lanceSearch.indexMessage(message).catch(err =>
      console.warn('[indexMessage] LanceDB index failed (non-fatal):', err)
    );

    return message;
  }

  async getSessionMessages(sessionId: string): Promise<MessageRecord[]> {
    this.ensureReady();
    return this.sessionIndex.getMessagesBySession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Search (delegates to LanceSearchService)
  // --------------------------------------------------------------------------

  async searchByKeyword(query: string, limit = 20): Promise<SearchResult[]> {
    return this.lanceSearch.searchByKeyword(query, limit);
  }

  async searchSemantic(query: string, limit = 20): Promise<SearchResult[]> {
    return this.lanceSearch.searchSemantic(query, limit);
  }

  async searchHybrid(query: string, limit = 20): Promise<SearchResult[]> {
    return this.lanceSearch.searchHybrid(query, limit);
  }

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  async runMaintenance(): Promise<{ deletedSessions: number; deletedMessages: number }> {
    const deletedMessages = await this.sessionIndex.cleanupOrphanedMessages();
    return { deletedSessions: 0, deletedMessages };
  }

  /**
   * Manually recreate messages and clear all sessions.
   * Destructive — called from Advanced Settings.
   */
  async recreateMessagesTable(): Promise<void> {
    // 1. Recreate SQLite messages table
    await this.sessionIndex.recreateMessagesTable();

    // 2. Clear all sessions from SQLite
    await this.sessionIndex.clearAllSessions();

    // 3. Best-effort recreate LanceDB search table
    await this.lanceSearch.recreateSearchTable();

    console.log('[recreateMessagesTable] Done — all data cleared');
  }

  // --------------------------------------------------------------------------
  // Checkpoint & file snapshot CRUD (delegates to SQLite)
  // --------------------------------------------------------------------------

  async createCheckpoint(sessionId: string, messageId?: string): Promise<string> {
    this.ensureReady();
    return this.sessionIndex.createCheckpoint(sessionId, messageId);
  }

  async getCheckpoints(sessionId: string) {
    this.ensureReady();
    return this.sessionIndex.getCheckpoints(sessionId);
  }

  async updateCheckpointStatus(id: string, status: string): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.updateCheckpointStatus(id, status);
  }

  async updateCheckpointDiffStats(id: string, totalAdditions: number, totalDeletions: number): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.updateCheckpointDiffStats(id, totalAdditions, totalDeletions);
  }

  async getSessionsPendingStats() {
    this.ensureReady();
    return this.sessionIndex.getSessionsPendingStats();
  }

  async insertFileSnapshot(checkpointId: string, filePath: string, originalContent: string | null, action: string): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.insertFileSnapshot(checkpointId, filePath, originalContent, action);
  }

  async getFileSnapshots(checkpointId: string) {
    this.ensureReady();
    return this.sessionIndex.getFileSnapshots(checkpointId);
  }

  async getSnapshotForFile(checkpointId: string, filePath: string) {
    this.ensureReady();
    return this.sessionIndex.getSnapshotForFile(checkpointId, filePath);
  }

  async updateFileSnapshotStatus(checkpointId: string, filePath: string, status: string): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.updateFileSnapshotStatus(checkpointId, filePath, status);
  }

  async updateFileSnapshotsDiffStats(checkpointId: string, fileStats: Array<{ path: string; additions: number; deletions: number }>): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.updateFileSnapshotsDiffStats(checkpointId, fileStats);
  }

  async pruneKeptCheckpointContent(checkpointId: string): Promise<void> {
    this.ensureReady();
    await this.sessionIndex.pruneKeptCheckpointContent(checkpointId);
  }

  async getPendingCheckpoints() {
    this.ensureReady();
    return this.sessionIndex.getPendingCheckpoints();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async close(): Promise<void> {
    await this.lanceSearch.close();
    await this.sessionIndex.close();
    this.initialized = false;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
let databaseServiceInstance: DatabaseService | null = null;

export function getDatabaseService(context?: vscode.ExtensionContext): DatabaseService {
  if (!databaseServiceInstance && context) {
    databaseServiceInstance = new DatabaseService(context);
  }
  if (!databaseServiceInstance) {
    throw new Error('DatabaseService not initialized. Call with context first.');
  }
  return databaseServiceInstance;
}

export function disposeDatabaseService(): void {
  if (databaseServiceInstance) {
    databaseServiceInstance.close();
    databaseServiceInstance = null;
  }
}
