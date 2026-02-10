import { MessageRecord, SessionRecord } from '../../types/session';

// ---------------------------------------------------------------------------
// LanceDB types (loaded lazily at runtime via dynamic import)
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchResult {
  message: MessageRecord;
  session: SessionRecord;
  snippet: string;
  score: number;
}

/** Callback for resolving a session by ID (supplied by DatabaseService). */
export type SessionLookupFn = (sessionId: string) => Promise<SessionRecord | null>;

// ============================================================================
// LanceSearchService — owns all LanceDB interactions (init, index, search).
// ============================================================================

export class LanceSearchService {
  private db: LanceDbConnection | null = null;
  private messagesTable: LanceDbTable | null = null;
  private lancedb: LanceDbModule | null = null;
  private lanceInitPromise: Promise<void> | null = null;
  private lanceInitialized = false;

  private readonly embeddingDimensions = 384;
  private readonly dbPath: string;
  private readonly getSession: SessionLookupFn;

  constructor(dbPath: string, getSession: SessionLookupFn) {
    this.dbPath = dbPath;
    this.getSession = getSession;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /** Kick off background init (non-blocking). */
  startInit(): void {
    this.lanceInitPromise = this.initLanceDb().catch(err => {
      console.warn('[LanceSearchService] LanceDB init failed (search will be unavailable):', err);
    });
  }

  /** Block until LanceDB is ready. Returns false if init failed. */
  async ensureReady(): Promise<boolean> {
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

      console.log(`Initializing LanceDB at: ${this.dbPath}`);
      this.db = await this.lancedb.connect(this.dbPath);

      // Open or create messages search table
      const tableNames = await this.db.tableNames();
      if (tableNames.includes('messages')) {
        this.messagesTable = await this.db.openTable('messages');
      } else {
        await this.createSearchTable();
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

  private async createSearchTable(): Promise<void> {
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

  // --------------------------------------------------------------------------
  // Indexing (fire-and-forget from DatabaseService)
  // --------------------------------------------------------------------------

  /** Index a single message for search. Non-critical — safe to ignore errors. */
  async indexMessage(message: MessageRecord): Promise<void> {
    const ready = await this.ensureReady();
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
      console.warn('[LanceSearchService.indexMessage] Failed:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  async searchByKeyword(query: string, limit = 20): Promise<SearchResult[]> {
    const ready = await this.ensureReady();
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
    const ready = await this.ensureReady();
    if (!ready || !this.messagesTable) return [];

    try {
      const queryVector = this.generateEmbedding(query);

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
    const ready = await this.ensureReady();
    if (!ready || !this.messagesTable) return [];

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
  // Cleanup
  // --------------------------------------------------------------------------

  /** Delete all search index entries for a given session. Best-effort. */
  async deleteSessionEntries(sessionId: string): Promise<void> {
    if (!this.messagesTable) return;
    try { await this.messagesTable.delete(`session_id = "${sessionId}"`); } catch { /* ignore */ }
  }

  /** Batch-delete search index entries for multiple sessions. Best-effort. */
  async deleteMultipleSessionEntries(ids: string[]): Promise<void> {
    if (!this.messagesTable || ids.length === 0) return;
    try {
      const filter = ids.map(id => `session_id = "${id}"`).join(' OR ');
      await this.messagesTable.delete(filter);
    } catch { /* ignore */ }
  }

  /** Drop and recreate the LanceDB messages search table. */
  async recreateSearchTable(): Promise<void> {
    if (!this.db || !this.lancedb) return;
    try {
      const tableNames = await this.db.tableNames();
      if (tableNames.includes('messages')) {
        await this.db.dropTable('messages');
      }
      this.messagesTable = null;
      await this.createSearchTable();
    } catch (err) {
      console.warn('[LanceSearchService.recreateSearchTable] Failed (non-fatal):', err);
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async close(): Promise<void> {
    // Wait for any in-flight background init before tearing down
    if (this.lanceInitPromise) {
      await this.lanceInitPromise.catch(() => { /* already logged */ });
      this.lanceInitPromise = null;
    }
    this.db = null;
    this.messagesTable = null;
    this.lancedb = null;
    this.lanceInitialized = false;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
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

  private generateEmbedding(text: string): number[] {
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
}
