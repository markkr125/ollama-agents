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
  update: (options: { where: string; values: Record<string, unknown> }) => Promise<void>;
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
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
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
// Embedding Queue - Background processing of embeddings
// ============================================================================

interface EmbeddingQueueItem {
  messageId: string;
  content: string;
}

class EmbeddingQueue {
  private queue: EmbeddingQueueItem[] = [];
  private processing = false;
  private embedFn: (text: string) => Promise<number[]>;
  private updateFn: (messageId: string, vector: number[]) => Promise<void>;

  constructor(
    embedFn: (text: string) => Promise<number[]>,
    updateFn: (messageId: string, vector: number[]) => Promise<void>
  ) {
    this.embedFn = embedFn;
    this.updateFn = updateFn;
  }

  enqueue(messageId: string, content: string): void {
    this.queue.push({ messageId, content });
    this.processNext();
  }

  private processNext(): void {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;

    setImmediate(async () => {
      try {
        const vector = await this.embedFn(item.content);
        await this.updateFn(item.messageId, vector);
      } catch (error) {
        console.error(`Failed to embed message ${item.messageId}:`, error);
      } finally {
        this.processing = false;
        this.processNext();
      }
    });
  }

  get pendingCount(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }
}

// ============================================================================
// Database Service
// ============================================================================

export class DatabaseService {
  private db: LanceDbConnection | null = null;
  private legacySessionsTable: LanceDbTable | null = null;
  private messagesTable: LanceDbTable | null = null;
  private lancedb: LanceDbModule | null = null;
  private embeddingQueue: EmbeddingQueue | null = null;
  private context: vscode.ExtensionContext;
  private ollamaClient: OllamaClient | null = null;
  private sessionIndex: SessionIndexService;
  private embeddingDimensions = 384; // sentence-transformers default
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private rebuildingMessagesTable = false;
  private lastTimestamp = 0; // Ensures strictly increasing timestamps
  private lastTimestampSessionId: string | null = null; // Session for which lastTimestamp is valid

  /**
   * Get a strictly increasing timestamp to ensure correct message ordering.
   * On first call for a session, queries DB for max timestamp to avoid conflicts.
   */
  private async getNextTimestamp(sessionId: string): Promise<number> {
    // If switching sessions or first call, sync lastTimestamp from DB
    if (this.lastTimestampSessionId !== sessionId) {
      this.lastTimestamp = await this.getMaxTimestampForSession(sessionId);
      this.lastTimestampSessionId = sessionId;
    }

    const now = Date.now();
    const timestamp = now <= this.lastTimestamp ? this.lastTimestamp + 1 : now;
    this.lastTimestamp = timestamp;
    return timestamp;
  }

  /**
   * Get the max timestamp from existing messages in a session.
   */
  private async getMaxTimestampForSession(sessionId: string): Promise<number> {
    try {
      const table = await this.getMessagesTable();
      const escapedSessionId = this.escapeSingleQuotes(sessionId);
      const results = await table
        .query()
        .where(`session_id = '${escapedSessionId}'`)
        .toArray();
      
      if (results.length === 0) {
        return 0;
      }
      
      let max = 0;
      for (const row of results) {
        const ts = (row as any).timestamp;
        if (typeof ts === 'number' && ts > max) {
          max = ts;
        }
      }
      return max;
    } catch {
      return 0;
    }
  }

  private escapeSingleQuotes(value: string): string {
    return value.replace(/'/g, "''");
  }

  private async getMessagesTable(): Promise<LanceDbTable> {
    await this.ensureReady();

    if (!this.db) {
      throw new Error('Database not connected');
    }

    // Return cached table if available
    if (this.messagesTable) {
      return this.messagesTable;
    }

    const tableNames = await this.db.tableNames();
    if (!tableNames.includes('messages')) {
      await this.createMessagesTable();
    } else {
      this.messagesTable = await this.db.openTable('messages');
    }

    return this.messagesTable!;
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.sessionIndex = new SessionIndexService(context);
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(ollamaClient?: OllamaClient): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.ollamaClient = ollamaClient || null;

    await this.sessionIndex.initialize();

    try {
      if (!cachedLanceDbModule) {
        const mod = await import('@lancedb/lancedb');
        cachedLanceDbModule = mod as unknown as LanceDbModule;
      }

      this.lancedb = cachedLanceDbModule;

      const storageUri = this.context.storageUri ?? this.context.globalStorageUri;
      const dbPath = vscode.Uri.joinPath(storageUri, 'ollama-copilot.lance').fsPath;

      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(storageUri);

      console.log(`Initializing LanceDB at: ${dbPath}`);
      this.db = await this.lancedb.connect(dbPath);

      // Initialize tables
      await this.initializeTables();
    } catch (error) {
      console.error('Failed to initialize LanceDB. Ensure dependencies are installed.', error);
      void vscode.window.showErrorMessage(
        'Ollama Copilot: LanceDB failed to load. Ensure @lancedb/lancedb is installed and available.'
      );
      throw error;
    }

    // Initialize embedding queue
    this.embeddingQueue = new EmbeddingQueue(
      (text) => this.generateEmbedding(text),
      (messageId, vector) => this.updateMessageVector(messageId, vector)
    );

    this.initialized = true;
    console.log('DatabaseService initialized successfully');
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializing) {
      this.initializing = this.initialize(this.ollamaClient ?? undefined)
        .finally(() => {
          this.initializing = null;
        });
    }

    await this.initializing;
  }

  private async initializeTables(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }
    try {
      await this.setupTables();
    } catch (error) {
      // Log the error but DO NOT wipe the database - that destroys user data
      console.error('Error during table setup (NOT wiping database):', error);
      // Try to at least open existing tables
      try {
        const tableNames = await this.db.tableNames();
        if (tableNames.includes('messages')) {
          this.messagesTable = await this.db.openTable('messages');
        }
      } catch (e) {
        console.error('Failed to recover tables:', e);
      }
    }
  }

  private async setupTables(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }

    const tableNames = await this.db.tableNames();

    // Messages table with vector column
    if (tableNames.includes('messages')) {
      this.messagesTable = await this.db.openTable('messages');
      // Skip destructive validation - just use the table as-is
      // Vector schema issues will be handled gracefully in updateMessageVector
    }

    if (!this.messagesTable) {
      await this.createMessagesTable();
    }

    await this.migrateLegacySessions(tableNames);
  }

  private async recreateTables(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }

    try {
      await this.db.dropTable('messages');
    } catch (error) {
      console.debug('Drop messages table skipped:', error);
    }

    try {
      await this.db.dropTable('sessions');
    } catch (error) {
      console.debug('Drop sessions table skipped:', error);
    }

    this.legacySessionsTable = null;
    this.messagesTable = null;

    // Recreate messages table from scratch
    await this.createMessagesTable();
  }

  private async createMessagesTable(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }

    // Create with initial schema including vector
    // Use a non-integer float to ensure Float64 type in LanceDB
    const zeroVector = new Array(this.embeddingDimensions).fill(0.0);
    zeroVector[0] = 0.5;
    this.messagesTable = await this.db.createTable('messages', [
      {
        id: '__schema__',
        session_id: '',
        role: 'user',
        content: '',
        model: '',
        tool_name: '',
        tool_input: '',
        tool_output: '',
        progress_title: '',
        timestamp: 0,
        vector: zeroVector
      }
    ]);
    // Remove schema row
    await this.messagesTable.delete('id = "__schema__"');

    // Create FTS index on content
    await this.messagesTable.createIndex('content', {
      config: this.lancedb.Index.fts()
    });
  }

  private async migrateLegacySessions(tableNames?: string[]): Promise<void> {
    if (!this.db) {
      return;
    }

    const names = tableNames || await this.db.tableNames();
    if (!names.includes('sessions')) {
      return;
    }

    try {
      this.legacySessionsTable = await this.db.openTable('sessions');
      const results = await this.legacySessionsTable.query().toArray();
      const sessions = (results as unknown as SessionRecord[])
        .filter(session => session.id && session.id !== '__schema__');

      for (const session of sessions) {
        await this.sessionIndex.upsertSession({
          ...session,
          status: session.status ?? 'completed'
        });
      }

      await this.db.dropTable('sessions');
      this.legacySessionsTable = null;
    } catch (error) {
      console.error('Failed to migrate legacy sessions table:', error);
    }
  }

  private async validateMessageVectorSchema(): Promise<void> {
    if (!this.messagesTable) {
      return;
    }

    const testId = `__schema_check__${Date.now()}`;
    const zeroVector = new Array(this.embeddingDimensions).fill(0.0);
    zeroVector[0] = 0.5;

    await this.messagesTable.add([
      {
        id: testId,
        session_id: '__schema__',
        role: 'user',
        content: '',
        model: '',
        tool_name: '',
        tool_input: '',
        tool_output: '',
        progress_title: '',
        timestamp: 0,
        vector: zeroVector
      }
    ]);

    await this.messagesTable.delete(`id = "${testId}"`);
  }

  // --------------------------------------------------------------------------
  // Embedding
  // --------------------------------------------------------------------------

  private async generateEmbedding(text: string): Promise<number[]> {
    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    const provider = config.get<string>('embedding.provider', 'builtin');

    if (provider === 'ollama' && this.ollamaClient) {
      return this.generateOllamaEmbedding(text);
    }

    return this.generateBuiltinEmbedding(text);
  }

  private async generateOllamaEmbedding(text: string): Promise<number[]> {
    if (!this.ollamaClient) {
      throw new Error('Ollama client not available');
    }

    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    const model = config.get<string>('embedding.model', 'nomic-embed-text');
    const baseUrl = config.get<string>('baseUrl', 'http://localhost:11434');

    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text })
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding.map(v => Number(v));
  }

  private async generateBuiltinEmbedding(text: string): Promise<number[]> {
    // Use LanceDB's built-in embedding via the embedding registry
    // For now, return a simple hash-based vector as placeholder
    // TODO: Integrate with LanceDB's sentence-transformers embedding
    // Use 0.0 to ensure Float64 type
    const vector = new Array(this.embeddingDimensions).fill(0.0);
    
    // Simple hash-based embedding (placeholder until proper integration)
    const words = text.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      for (let j = 0; j < word.length; j++) {
        const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % this.embeddingDimensions;
        vector[idx] += 1 / (words.length * word.length);
      }
    }

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }

  private async updateMessageVector(messageId: string, vector: number[]): Promise<void> {
    if (!this.messagesTable) {
      return;
    }

    try {
      await this.messagesTable.update({
        where: `id = "${messageId}"`,
        values: { vector: Array.from(vector, v => Number(v)) }
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      if (message.includes('Array expressions must have a consistent datatype')) {
        await this.recoverMessagesTableForVectorMismatch();
        return;
      }
      throw error;
    }
  }

  private async recoverMessagesTableForVectorMismatch(): Promise<void> {
    // DISABLED: This function was dropping the messages table and could lose data.
    // Vector mismatches are not critical - just log and skip embedding updates.
    console.warn('Vector mismatch detected - skipping embedding update (data preserved)');
    return;
  }

  // --------------------------------------------------------------------------
  // Session CRUD
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
    // Delete the session from SQLite
    await this.sessionIndex.deleteSession(id);

    // Delete all messages for this session (best-effort)
    const table = this.messagesTable || (this.db ? await this.db.openTable('messages').catch(() => null) : null);
    this.messagesTable = table;
    if (!table) {
      return;
    }

    try {
      await table.delete(`session_id = "${id}"`);
    } catch (error) {
      console.error('Failed to delete session messages:', error);
    }
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    return this.sessionIndex.listSessions(limit, offset);
  }

  async resetGeneratingSessions(status: ChatSessionStatus = 'idle'): Promise<void> {
    await this.sessionIndex.resetGeneratingSessions(status);
  }

  // --------------------------------------------------------------------------
  // Message CRUD
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
      timestamp: await this.getNextTimestamp(sessionId),
      vector: new Array(this.embeddingDimensions).fill(0.0)
    };

    try {
      const table = await this.getMessagesTable();
      await table.add([message as unknown as Record<string, unknown>]);
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error(`[addMessage] ERROR: ${errorMsg}`);
      
      // Detect LanceDB corruption (missing files only - NOT schema mismatch)
      if (errorMsg.includes('Not found:') && errorMsg.includes('.lance')) {
        console.warn('[addMessage] LanceDB file corruption detected - recreating messages table');
        await this.handleCorruptedMessagesTable();
        
        // Retry adding message after recovery
        const table = await this.getMessagesTable();
        await table.add([message as unknown as Record<string, unknown>]);
      } else {
        throw error;
      }
    }

    // Update session's updated_at
    await this.updateSession(sessionId, {});

    return message;
  }

  async getSessionMessages(sessionId: string): Promise<MessageRecord[]> {
    try {
      const table = await this.getMessagesTable();
      const escapedSessionId = this.escapeSingleQuotes(sessionId);
      
      const results = await table
        .query()
        .where(`session_id = '${escapedSessionId}'`)
        .toArray();

      return (results as unknown as MessageRecord[])
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error(`[getSessionMessages] ERROR: ${errorMsg}`);
      
      // Detect LanceDB corruption (missing files only - NOT schema mismatch)
      if (errorMsg.includes('Not found:') && errorMsg.includes('.lance')) {
        console.warn('[getSessionMessages] LanceDB file corruption detected - recreating messages table');
        await this.handleCorruptedMessagesTable();
        return []; // Return empty after recovery
      }
      
      throw error;
    }
  }

  /**
   * Handle corrupted messages table by deleting and recreating it.
   * This loses existing messages but allows the extension to function.
   */
  private async handleCorruptedMessagesTable(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      // Drop the corrupted table
      const tableNames = await this.db.tableNames();
      if (tableNames.includes('messages')) {
        await this.db.dropTable('messages');
        console.log('[handleCorruptedMessagesTable] Dropped corrupted messages table');
      }
      
      this.messagesTable = null;
      
      // Recreate it fresh
      await this.createMessagesTable();
      console.log('[handleCorruptedMessagesTable] Created fresh messages table');
    } catch (error: any) {
      console.error('[handleCorruptedMessagesTable] Failed to recover:', error?.message || error);
    }
  }

  /**
   * Manually recreate the messages table and clear all sessions.
   * This is a destructive operation that deletes all chat history.
   * Called from Advanced Settings UI.
   */
  async recreateMessagesTable(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    console.log('[recreateMessagesTable] Starting manual table recreation...');
    
    // Drop existing messages table
    const tableNames = await this.db.tableNames();
    if (tableNames.includes('messages')) {
      await this.db.dropTable('messages');
      console.log('[recreateMessagesTable] Dropped existing messages table');
    }
    
    this.messagesTable = null;
    
    // Create fresh messages table
    await this.createMessagesTable();
    console.log('[recreateMessagesTable] Created fresh messages table');

    // Also clear all sessions from SQLite
    await this.sessionIndex.clearAllSessions();
    console.log('[recreateMessagesTable] Cleared all sessions');
  }

  async deleteMessage(id: string): Promise<void> {
    if (!this.messagesTable) {
      return;
    }

    await this.messagesTable.delete(`id = "${id}"`);
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  async searchByKeyword(query: string, limit = 20): Promise<SearchResult[]> {
    if (!this.messagesTable) {
      return [];
    }

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
    if (!this.messagesTable) {
      return [];
    }

    try {
      const queryVector = await this.generateEmbedding(query);
      
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
    if (!this.messagesTable) {
      return [];
    }

    try {
      // Perform both searches
      const [keywordResults, semanticResults] = await Promise.all([
        this.searchByKeyword(query, limit),
        this.searchSemantic(query, limit)
      ]);

      // RRF (Reciprocal Rank Fusion) reranking
      const k = 60; // RRF constant
      const scores = new Map<string, number>();
      const resultMap = new Map<string, SearchResult>();

      // Score keyword results
      keywordResults.forEach((result, rank) => {
        const score = 1 / (k + rank + 1);
        scores.set(result.message.id, (scores.get(result.message.id) || 0) + score);
        resultMap.set(result.message.id, result);
      });

      // Score semantic results
      semanticResults.forEach((result, rank) => {
        const score = 1 / (k + rank + 1);
        scores.set(result.message.id, (scores.get(result.message.id) || 0) + score);
        if (!resultMap.has(result.message.id)) {
          resultMap.set(result.message.id, result);
        }
      });

      // Sort by combined score
      const rankedIds = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id);

      return rankedIds
        .map(id => {
          const result = resultMap.get(id)!;
          result.score = scores.get(id)!;
          return result;
        });
    } catch (error) {
      console.error('Hybrid search failed:', error);
      // Fallback to keyword search only
      return this.searchByKeyword(query, limit);
    }
  }

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  async runMaintenance(): Promise<{ deletedSessions: number; deletedMessages: number }> {
    if (!this.messagesTable) {
      return { deletedSessions: 0, deletedMessages: 0 };
    }

    const sessions = await this.sessionIndex.listAllSessions();
    const sessionIdSet = new Set(sessions.map(session => session.id));

    const messages = await this.messagesTable.query().toArray();
    const messageRecords = messages as unknown as MessageRecord[];

    let deletedMessages = 0;
    const messageSessionIds = new Set<string>();

    for (const message of messageRecords) {
      messageSessionIds.add(message.session_id);
      if (!sessionIdSet.has(message.session_id)) {
        await this.messagesTable.delete(`id = "${message.id}"`);
        deletedMessages++;
      }
    }

    let deletedSessions = 0;
    for (const session of sessions) {
      if (!messageSessionIds.has(session.id)) {
        await this.sessionIndex.deleteSession(session.id);
        deletedSessions++;
      }
    }

    return { deletedSessions, deletedMessages };
  }

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
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength - 3) + '...';
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async close(): Promise<void> {
    // LanceDB connections don't need explicit close in JS
    this.db = null;
    this.legacySessionsTable = null;
    this.messagesTable = null;
    this.lancedb = null;
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
