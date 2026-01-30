import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';

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
  vectorSearch: (vector: number[]) => {
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

// ============================================================================
// Types
// ============================================================================

export interface SessionRecord {
  id: string;
  title: string;
  mode: string;
  model: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  model?: string;
  tool_name?: string;
  tool_input?: string;
  tool_output?: string;
  progress_title?: string;
  timestamp: number;
  vector?: number[];
}

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
  private sessionsTable: LanceDbTable | null = null;
  private messagesTable: LanceDbTable | null = null;
  private lancedb: LanceDbModule | null = null;
  private embeddingQueue: EmbeddingQueue | null = null;
  private context: vscode.ExtensionContext;
  private ollamaClient: OllamaClient | null = null;
  private embeddingDimensions = 384; // sentence-transformers default
  private initialized = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(ollamaClient?: OllamaClient): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.ollamaClient = ollamaClient || null;

    try {
      if (!cachedLanceDbModule) {
        const mod = await import('@lancedb/lancedb');
        cachedLanceDbModule = mod as unknown as LanceDbModule;
      }

      this.lancedb = cachedLanceDbModule;

      const dbPath = vscode.Uri.joinPath(
        this.context.globalStorageUri,
        'ollama-copilot.lance'
      ).fsPath;

      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);

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

  private async initializeTables(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }
    try {
      await this.setupTables();
    } catch (error) {
      console.error('LanceDB appears corrupted. Recreating database tables.', error);
      void vscode.window.showWarningMessage(
        'Ollama Copilot: Database appears corrupted. Recreating it now.'
      );
      await this.recreateTables();
    }
  }

  private async setupTables(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }

    const tableNames = await this.db.tableNames();

    // Sessions table
    if (tableNames.includes('sessions')) {
      this.sessionsTable = await this.db.openTable('sessions');
    } else {
      // Create with initial schema
      this.sessionsTable = await this.db.createTable('sessions', [
        {
          id: '__schema__',
          title: '',
          mode: '',
          model: '',
          created_at: 0,
          updated_at: 0
        }
      ]);
      // Remove schema row
      await this.sessionsTable.delete('id = "__schema__"');
    }

    // Messages table with vector column
    if (tableNames.includes('messages')) {
      this.messagesTable = await this.db.openTable('messages');

      // Validate vector schema; if incompatible, drop and recreate the table
      try {
        await this.validateMessageVectorSchema();
      } catch (e) {
        console.log('Detected incompatible vector schema, recreating messages table:', e);
        await this.db.dropTable('messages');
        this.messagesTable = null;
      }
    }

    if (!this.messagesTable) {
      await this.createMessagesTable();
    }
  }

  private async recreateTables(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }

    try {
      await this.db.dropTable('messages');
    } catch {
      // ignore if missing
    }

    try {
      await this.db.dropTable('sessions');
    } catch {
      // ignore if missing
    }

    this.sessionsTable = null;
    this.messagesTable = null;

    // Recreate tables from scratch
    this.sessionsTable = await this.db.createTable('sessions', [
      {
        id: '__schema__',
        title: '',
        mode: '',
        model: '',
        created_at: 0,
        updated_at: 0
      }
    ]);
    await this.sessionsTable.delete('id = "__schema__"');

    await this.createMessagesTable();
  }

  private async createMessagesTable(): Promise<void> {
    if (!this.db || !this.lancedb) {
      throw new Error('Database not connected');
    }

    // Create with initial schema including vector
    // Use 0.0 to ensure Float64 type (not Int64) for compatibility with embeddings
    const zeroVector = new Array(this.embeddingDimensions).fill(0.0);
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

  private async validateMessageVectorSchema(): Promise<void> {
    if (!this.messagesTable) {
      return;
    }

    const testId = `__schema_check__${Date.now()}`;
    const zeroVector = new Array(this.embeddingDimensions).fill(0.0);

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
    return data.embedding;
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

    await this.messagesTable.update({
      where: `id = "${messageId}"`,
      values: { vector }
    });
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  async createSession(
    title: string,
    mode: string,
    model: string
  ): Promise<SessionRecord> {
    if (!this.sessionsTable) {
      throw new Error('Sessions table not initialized');
    }

    const session: SessionRecord = {
      id: generateId(),
      title,
      mode,
      model,
      created_at: Date.now(),
      updated_at: Date.now()
    };

    await this.sessionsTable.add([session as unknown as Record<string, unknown>]);
    return session;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    if (!this.sessionsTable) {
      return null;
    }

    const results = await this.sessionsTable
      .query()
      .where(`id = "${id}"`)
      .limit(1)
      .toArray();

    return results.length > 0 ? (results[0] as unknown as SessionRecord) : null;
  }

  async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
    if (!this.sessionsTable) {
      return;
    }

    await this.sessionsTable.update({
      where: `id = "${id}"`,
      values: { ...updates, updated_at: Date.now() }
    });
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.sessionsTable || !this.messagesTable) {
      return;
    }

    // Delete all messages for this session
    await this.messagesTable.delete(`session_id = "${id}"`);
    
    // Delete the session
    await this.sessionsTable.delete(`id = "${id}"`);
  }

  async listSessions(limit = 50): Promise<SessionRecord[]> {
    if (!this.sessionsTable) {
      return [];
    }

    const results = await this.sessionsTable
      .query()
      .toArray();

    // Sort by updated_at descending (most recent first)
    const sessions = results as unknown as SessionRecord[];
    return sessions
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
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
    if (!this.messagesTable) {
      throw new Error('Messages table not initialized');
    }

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
      timestamp: Date.now(),
      // Use 0.0 to ensure Float64 type for compatibility with embeddings
      vector: new Array(this.embeddingDimensions).fill(0.0)
    };

    await this.messagesTable.add([message as unknown as Record<string, unknown>]);

    // Queue embedding generation in background
    if (content && this.embeddingQueue) {
      this.embeddingQueue.enqueue(message.id, content);
    }

    // Update session's updated_at
    await this.updateSession(sessionId, {});

    return message;
  }

  async getSessionMessages(sessionId: string): Promise<MessageRecord[]> {
    if (!this.messagesTable) {
      return [];
    }

    const results = await this.messagesTable
      .query()
      .where(`session_id = "${sessionId}"`)
      .toArray();

    const messages = results as unknown as MessageRecord[];
    return messages.sort((a, b) => a.timestamp - b.timestamp);
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
    if (!this.messagesTable || !this.sessionsTable) {
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
    if (!this.messagesTable || !this.sessionsTable) {
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
    if (!this.messagesTable || !this.sessionsTable) {
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
    this.sessionsTable = null;
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
