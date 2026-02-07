import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ChatSessionStatus, MessageRecord, SessionRecord, SessionsPage } from '../types/session';
import { OllamaClient } from './ollamaClient';
import { SessionIndexService } from './sessionIndexService';

// ---------------------------------------------------------------------------
// Optional LanceDB types (loaded lazily at runtime)
// ---------------------------------------------------------------------------

type LanceDbTable = {
  delete: (filter: string) => Promise<void>;
  createIndex: (column: string, options: { config: unknown }) => Promise<void>;
  query: () => {
    where: (clause: string) => any;
    limit: (n: number) => any;
    toArray: () => Promise<any[]>;
  };
  add: (rows: Record<string, unknown>[]) => Promise<void>;
  search: (query: string) => {
    limit: (n: number) => any;
    toArray: () => Promise<any[]>;
  };
  vectorSearch: (vector: number[] | Float32Array) => {
    limit: (n: number) => any;
    toArray: () => Promise<any[]>;
  };
};

type LanceDbConnection = {
  tableNames: () => Promise<string[]>;
  openTable: (name: string) => Promise<LanceDbTable>;
  createTable: (name: string, rows: Record<string, unknown>[]) => Promise<LanceDbTable>;
  dropTable: (name: string) => Promise<void>;
};

type LanceDbModule = {
  connect: (path: string) => Promise<LanceDbConnection>;
  Index: { fts: () => unknown };
};

let cachedLanceDbModule: LanceDbModule | null = null;

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

export interface SearchResult {
  message: MessageRecord;
  session: SessionRecord;
  snippet: string;
  score: number;
}

// ============================================================================
// Database Service
// ============================================================================

/**
 * DatabaseService is a facade that:
 * - Delegates all session & message CRUD to SessionIndexService (SQLite).
 * - Manages LanceDB lazily for search (FTS + future vector + RRF reranking).
 * - Provides fire-and-forget indexMessage() for search indexing.
 */
export class DatabaseService {
  // LanceDB (search-only, lazy-loaded)
  private db: LanceDbConnection | null = null;
  private messagesTable: LanceDbTable | null = null;
  private lancedb: LanceDbModule | null = null;
  private lanceInitPromise: Promise<void> | null = null;
  private lanceInitialized = false;

  // SQLite (primary storage, eager-loaded)
  private sessionIndex: SessionIndexService;

  private context: vscode.ExtensionContext;
  private ollamaClient: OllamaClient | null = null;
  private initialized = false;
  private embeddingDimensions = 384;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.sessionIndex = new SessionIndexService(context);
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(ollamaClient?: OllamaClient): Promise<void> {
    if (this.initialized) return;

    this.ollamaClient = ollamaClient || null;

    // Eagerly init SQLite (fast, native)
    await this.sessionIndex.initialize();

    // Kick off LanceDB init in background (lazy — don't block activation)
    this.lanceInitPromise = this.initLanceDb().catch(err => {
      console.warn('[DatabaseService] LanceDB init failed (search will be unavailable):', err);
    });

    this.initialized = true;
    console.log('DatabaseService initialized (SQLite ready, LanceDB loading in background)');
  }

  /**
   * Lazy LanceDB initialization — only blocks when search is first used.
   */
  private async ensureLanceReady(): Promise<boolean> {
    if (this.lanceInitialized) return true;
    if (this.lanceInitPromise) {
      await this.lanceInitPromise;
    }
    return this.lanceInitialized;
  }

  private async initLanceDb(): Promise<void> {
    try {
      if (!cachedLanceDbModule) {
        const mod = await import('@lancedb/lancedb');
        cachedLanceDbModule = mod as unknown as LanceDbModule;
      }

      this.lancedb = cachedLanceDbModule;

      const storageUri = this.context.storageUri ?? this.context.globalStorageUri;
      const dbPath = vscode.Uri.joinPath(storageUri, 'ollama-copilot.lance').fsPath;
      await vscode.workspace.fs.createDirectory(storageUri);

      console.log(`Initializing LanceDB at: ${dbPath}`);
      this.db = await this.lancedb.connect(dbPath);

      // Open or create messages search table
      const tableNames = await this.db.tableNames();
      if (tableNames.includes('messages')) {
        this.messagesTable = await this.db.openTable('messages');
      } else {
        await this.createLanceSearchTable();
      }

      // Clean up legacy sessions table if it exists
      if (tableNames.includes('sessions')) {
        try { await this.db.dropTable('sessions'); } catch { /* ignore */ }
      }

      this.lanceInitialized = true;
      console.log('LanceDB initialized (search ready)');
    } catch (error) {
      console.error('Failed to initialize LanceDB:', error);
      throw error;
    }
  }

  private async createLanceSearchTable(): Promise<void> {
    if (!this.db || !this.lancedb) return;

    const zeroVector = new Array(this.embeddingDimensions).fill(0.0);
    zeroVector[0] = 0.5;
    this.messagesTable = await this.db.createTable('messages', [
      {
        id: '__schema__',
        session_id: '',
        role: 'user',
        content: '',
        timestamp: 0,
        vector: zeroVector
      }
    ]);
    await this.messagesTable.delete('id = "__schema__"');
    await this.messagesTable.createIndex('content', {
      config: this.lancedb.Index.fts()
    });
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
    if (this.messagesTable) {
      try { await this.messagesTable.delete(`session_id = "${id}"`); } catch { /* ignore */ }
    }
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    return this.sessionIndex.listSessions(limit, offset);
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

    // Best-effort LanceDB cleanup — single batched filter instead of per-id loop
    if (this.messagesTable && ids.length > 0) {
      try {
        const filter = ids.map(id => `session_id = "${id}"`).join(' OR ');
        await this.messagesTable.delete(filter);
      } catch { /* ignore */ }
    }

    if (onProgress) {
      onProgress(ids.length, ids.length);
    }
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
      timestamp: await this.sessionIndex.getNextTimestamp(sessionId)
    };

    // Primary storage: SQLite (indexed, fast)
    await this.sessionIndex.addMessage(message);

    // Update session's updated_at
    await this.sessionIndex.updateSession(sessionId, {});

    // Fire-and-forget: index in LanceDB for search
    this.indexMessageForSearch(message).catch(err =>
      console.warn('[indexMessage] LanceDB index failed (non-fatal):', err)
    );

    return message;
  }

  async getSessionMessages(sessionId: string): Promise<MessageRecord[]> {
    this.ensureReady();
    return this.sessionIndex.getMessagesBySession(sessionId);
  }

  /**
   * Fire-and-forget write to LanceDB for search indexing.
   * Non-critical — if this fails, messages are still safe in SQLite.
   */
  private async indexMessageForSearch(message: MessageRecord): Promise<void> {
    const ready = await this.ensureLanceReady();
    if (!ready || !this.messagesTable) return;

    // Only index user/assistant messages with actual content
    if (message.role === 'tool' || !message.content?.trim()) return;

    try {
      const zeroVector = new Array(this.embeddingDimensions).fill(0.0);
      await this.messagesTable.add([{
        id: message.id,
        session_id: message.session_id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        vector: zeroVector
      }]);
    } catch (error) {
      // Non-fatal — search index can be rebuilt from SQLite
      console.warn('[indexMessageForSearch] Failed:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Search (LanceDB)
  // --------------------------------------------------------------------------

  async searchByKeyword(query: string, limit = 20): Promise<SearchResult[]> {
    const ready = await this.ensureLanceReady();
    if (!ready || !this.messagesTable) return [];

    try {
      const results = await this.messagesTable
        .search(query)
        .limit(limit)
        .toArray();

      return this.enrichSearchResults(results as unknown as MessageRecord[]);
    } catch (error) {
      console.error('Keyword search failed:', error);
      return [];
    }
  }

  async searchSemantic(query: string, limit = 20): Promise<SearchResult[]> {
    const ready = await this.ensureLanceReady();
    if (!ready || !this.messagesTable) return [];

    try {
      const queryVector = await this.generateBuiltinEmbedding(query);

      const results = await this.messagesTable
        .vectorSearch(queryVector)
        .limit(limit)
        .toArray();

      return this.enrichSearchResults(results as unknown as MessageRecord[]);
    } catch (error) {
      console.error('Semantic search failed:', error);
      return [];
    }
  }

  async searchHybrid(query: string, limit = 20): Promise<SearchResult[]> {
    const ready = await this.ensureLanceReady();
    if (!ready || !this.messagesTable) {
      // Fallback: if LanceDB isn't ready, return empty results
      return [];
    }

    try {
      const [keywordResults, semanticResults] = await Promise.all([
        this.searchByKeyword(query, limit),
        this.searchSemantic(query, limit)
      ]);

      // RRF (Reciprocal Rank Fusion) reranking
      const k = 60;
      const scores = new Map<string, number>();
      const resultMap = new Map<string, SearchResult>();

      keywordResults.forEach((result, rank) => {
        const score = 1 / (k + rank + 1);
        scores.set(result.message.id, (scores.get(result.message.id) || 0) + score);
        resultMap.set(result.message.id, result);
      });

      semanticResults.forEach((result, rank) => {
        const score = 1 / (k + rank + 1);
        scores.set(result.message.id, (scores.get(result.message.id) || 0) + score);
        if (!resultMap.has(result.message.id)) {
          resultMap.set(result.message.id, result);
        }
      });

      const rankedIds = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id);

      return rankedIds.map(id => {
        const result = resultMap.get(id)!;
        result.score = scores.get(id)!;
        return result;
      });
    } catch (error) {
      console.error('Hybrid search failed:', error);
      return this.searchByKeyword(query, limit);
    }
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
    if (this.db && this.lancedb) {
      try {
        const tableNames = await this.db.tableNames();
        if (tableNames.includes('messages')) {
          await this.db.dropTable('messages');
        }
        this.messagesTable = null;
        await this.createLanceSearchTable();
      } catch (err) {
        console.warn('[recreateMessagesTable] LanceDB cleanup failed (non-fatal):', err);
      }
    }

    console.log('[recreateMessagesTable] Done — all data cleared');
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async enrichSearchResults(messages: MessageRecord[]): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const sessionCache = new Map<string, SessionRecord>();

    for (const message of messages) {
      let session = sessionCache.get(message.session_id);
      if (!session) {
        session = await this.getSession(message.session_id) || undefined;
        if (session) {
          sessionCache.set(message.session_id, session);
        }
      }

      if (session) {
        results.push({
          message,
          session,
          snippet: this.createSnippet(message.content),
          score: 0
        });
      }
    }

    return results;
  }

  private createSnippet(content: string, maxLength = 150): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength - 3) + '...';
  }

  private async generateBuiltinEmbedding(text: string): Promise<number[]> {
    const vector = new Array(this.embeddingDimensions).fill(0.0);
    const words = text.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      for (let j = 0; j < word.length; j++) {
        const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % this.embeddingDimensions;
        vector[idx] += 1 / (words.length * word.length);
      }
    }
    const magnitude = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }
    return vector;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async close(): Promise<void> {
    // Wait for any in-flight LanceDB background init to settle before tearing down.
    // Without this, a second instance opening the same directory can hit corrupt state.
    if (this.lanceInitPromise) {
      await this.lanceInitPromise.catch(() => { /* already logged */ });
      this.lanceInitPromise = null;
    }

    await this.sessionIndex.close();
    this.db = null;
    this.messagesTable = null;
    this.lancedb = null;
    this.lanceInitialized = false;
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
