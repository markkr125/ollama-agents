import * as vscode from 'vscode';
import { Model } from '../../types/ollama';
import { ChatSessionStatus, MessageRecord, SessionRecord, SessionsPage } from '../../types/session';
import { CheckpointRepository } from './checkpointRepository';
import { MessageRepository } from './messageRepository';
import { SessionRepository } from './sessionRepository';
import { dbAll, dbExec, dbRun, SqliteDb } from './sqliteHelpers';

// ---------------------------------------------------------------------------
// SessionIndexService — native SQLite via @vscode/sqlite3
//
// Owns the DB lifecycle (open, schema, migrations, close) and delegates
// CRUD to focused repository classes. Keeps model cache methods here
// (only 3 methods — too small for their own repository).
// ---------------------------------------------------------------------------

export class SessionIndexService {
  private db: SqliteDb | null = null;
  private initialized = false;
  private storageUri: vscode.Uri;

  // Repositories (created after DB opens)
  private _sessions!: SessionRepository;
  private _messages!: MessageRepository;
  private _checkpoints!: CheckpointRepository;

  constructor(storageUri: vscode.Uri) {
    this.storageUri = storageUri;
  }

  // ---------------------------------------------------------------------------
  // Initialization — schema + migrations
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await vscode.workspace.fs.createDirectory(this.storageUri);

    const dbPath = vscode.Uri.joinPath(this.storageUri, 'sessions.sqlite').fsPath;

    const sqlite3 = require('@vscode/sqlite3');
    this.db = await new Promise<SqliteDb>((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, (err: Error | null) => {
        if (err) reject(err);
        else resolve(db as SqliteDb);
      });
    });

    // Enable WAL mode for better concurrent read perf + incremental writes
    await dbExec(this.db, 'PRAGMA journal_mode=WAL;');
    await dbExec(this.db, 'PRAGMA foreign_keys=ON;');

    // ---- Sessions table ----
    await dbExec(this.db, `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        auto_approve_commands INTEGER NOT NULL DEFAULT 0,
        auto_approve_sensitive_edits INTEGER NOT NULL DEFAULT 0,
        sensitive_file_patterns TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await dbExec(this.db, `
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON sessions(updated_at DESC);
    `);

    // ---- Messages table ----
    await dbExec(this.db, `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        model TEXT,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        progress_title TEXT,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
    await dbExec(this.db, `
      CREATE INDEX IF NOT EXISTS idx_messages_session_ts
      ON messages(session_id, timestamp);
    `);

    // ---- Models cache table ----
    await dbExec(this.db, `
      CREATE TABLE IF NOT EXISTS models (
        name TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        modified_at TEXT NOT NULL DEFAULT '',
        digest TEXT NOT NULL DEFAULT '',
        family TEXT,
        families TEXT,
        parameter_size TEXT,
        quantization_level TEXT,
        capabilities TEXT,
        fetched_at INTEGER NOT NULL
      );
    `);

    // Schema migrations (idempotent column additions)
    await this.ensureColumn('sessions', 'status', "TEXT DEFAULT 'completed'");
    await this.ensureColumn('sessions', 'auto_approve_commands', 'INTEGER NOT NULL DEFAULT 0');
    await this.ensureColumn('sessions', 'auto_approve_sensitive_edits', 'INTEGER NOT NULL DEFAULT 0');
    await this.ensureColumn('sessions', 'sensitive_file_patterns', 'TEXT DEFAULT NULL');
    await this.ensureColumn('models', 'capabilities', 'TEXT DEFAULT NULL');
    await this.ensureColumn('models', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
    await this.ensureColumn('models', 'context_length', 'INTEGER DEFAULT NULL');
    await this.ensureColumn('models', 'max_context', 'INTEGER DEFAULT NULL');

    // ---- Checkpoints table (file-change tracking per agent request) ----
    await dbExec(this.db, `
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
    await dbExec(this.db, `
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
      ON checkpoints(session_id, created_at DESC);
    `);

    // ---- File snapshots table (original content captured before agent edits) ----
    await dbExec(this.db, `
      CREATE TABLE IF NOT EXISTS file_snapshots (
        id TEXT PRIMARY KEY,
        checkpoint_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_content TEXT,
        action TEXT NOT NULL DEFAULT 'modified',
        file_status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
        UNIQUE(checkpoint_id, file_path)
      );
    `);
    await dbExec(this.db, `
      CREATE INDEX IF NOT EXISTS idx_snapshots_checkpoint
      ON file_snapshots(checkpoint_id);
    `);

    // Additive migrations for checkpoint diff stats
    await this.ensureColumn('checkpoints', 'total_additions', 'INTEGER DEFAULT NULL');
    await this.ensureColumn('checkpoints', 'total_deletions', 'INTEGER DEFAULT NULL');

    // Per-file diff stats (accurate session totals after partial keep/undo)
    await this.ensureColumn('file_snapshots', 'additions', 'INTEGER DEFAULT NULL');
    await this.ensureColumn('file_snapshots', 'deletions', 'INTEGER DEFAULT NULL');

    // Session memory persistence (serialized JSON of structured agent notes)
    await this.ensureColumn('sessions', 'session_memory', 'TEXT DEFAULT NULL');

    // Per-session explorer model override
    await this.ensureColumn('sessions', 'explorer_model', "TEXT DEFAULT ''");

    // Tool calls metadata on assistant messages (serialized JSON)
    await this.ensureColumn('messages', 'tool_calls', 'TEXT DEFAULT NULL');

    // Create repositories now that DB is ready
    const getDb = () => this.getDb();
    this._sessions = new SessionRepository(getDb);
    this._messages = new MessageRepository(getDb);
    this._checkpoints = new CheckpointRepository(getDb);

    this.initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getDb(): SqliteDb {
    if (!this.initialized || !this.db) {
      throw new Error('SessionIndexService not initialized');
    }
    return this.db;
  }

  private ensureReady(): void {
    if (!this.initialized || !this.db) {
      throw new Error('SessionIndexService not initialized');
    }
  }

  private async hasColumn(table: string, column: string): Promise<boolean> {
    if (!this.db) return false;
    try {
      const rows = await dbAll(this.db, `PRAGMA table_info(${table});`);
      return rows.some((row: any) => String(row.name) === column);
    } catch (error) {
      console.error('Failed to check table column:', { table, column, error });
      return false;
    }
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    if (!this.db) return;
    if (await this.hasColumn(table, column)) return;
    await dbRun(this.db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  async close(): Promise<void> {
    if (this.db) {
      const { dbClose } = await import('./sqliteHelpers');
      await dbClose(this.db);
      this.db = null;
      this.initialized = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Session CRUD — delegates to SessionRepository
  // ---------------------------------------------------------------------------

  async createSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    return this._sessions.createSession(record);
  }

  async upsertSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    return this._sessions.upsertSession(record);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    this.ensureReady();
    return this._sessions.getSession(id);
  }

  async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
    this.ensureReady();
    return this._sessions.updateSession(id, updates);
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureReady();
    return this._sessions.deleteSession(id);
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    this.ensureReady();
    return this._sessions.listSessions(limit, offset);
  }

  async listAllSessions(): Promise<SessionRecord[]> {
    this.ensureReady();
    return this._sessions.listAllSessions();
  }

  async resetGeneratingSessions(status: ChatSessionStatus = 'idle'): Promise<void> {
    this.ensureReady();
    return this._sessions.resetGeneratingSessions(status);
  }

  async saveSessionMemory(sessionId: string, memoryJson: string): Promise<void> {
    this.ensureReady();
    return this._sessions.saveSessionMemory(sessionId, memoryJson);
  }

  async loadSessionMemory(sessionId: string): Promise<string | null> {
    this.ensureReady();
    return this._sessions.loadSessionMemory(sessionId);
  }

  async findIdleEmptySession(): Promise<string | null> {
    this.ensureReady();
    return this._sessions.findIdleEmptySession();
  }

  async deleteMultipleSessions(ids: string[]): Promise<void> {
    this.ensureReady();
    return this._sessions.deleteMultipleSessions(ids);
  }

  async clearAllSessions(): Promise<void> {
    this.ensureReady();
    return this._sessions.clearAllSessions();
  }

  // ---------------------------------------------------------------------------
  // Model cache CRUD (kept inline — only 3 methods)
  // ---------------------------------------------------------------------------

  async upsertModels(models: Model[]): Promise<void> {
    this.ensureReady();
    const now = Date.now();
    const existingRows = await dbAll(this.db!, 'SELECT name, enabled, max_context FROM models;');
    const enabledMap = new Map(existingRows.map(r => [String(r.name), Number(r.enabled ?? 1)]));
    const maxCtxMap = new Map(existingRows.map(r => [String(r.name), r.max_context != null ? Number(r.max_context) : null]));
    await dbRun(this.db!, 'DELETE FROM models;');
    for (const m of models) {
      const enabled = m.enabled !== undefined ? (m.enabled ? 1 : 0) : (enabledMap.get(m.name) ?? 1);
      const maxCtx = maxCtxMap.get(m.name) ?? null;
      await dbRun(this.db!,
        `INSERT OR REPLACE INTO models (name, size, modified_at, digest, family, families, parameter_size, quantization_level, capabilities, enabled, context_length, max_context, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          m.name,
          m.size ?? 0,
          m.modified_at ?? '',
          m.digest ?? '',
          m.details?.family ?? null,
          m.details?.families ? JSON.stringify(m.details.families) : null,
          m.details?.parameter_size ?? null,
          m.details?.quantization_level ?? null,
          m.capabilities ? JSON.stringify(m.capabilities) : null,
          enabled,
          (m as any).contextLength ?? null,
          maxCtx,
          now
        ]
      );
    }
  }

  async getCachedModels(): Promise<Model[]> {
    this.ensureReady();
    const rows = await dbAll(this.db!, 'SELECT * FROM models ORDER BY name ASC;');
    return rows.map(r => this.mapModelRow(r));
  }

  async setModelEnabled(name: string, enabled: boolean): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!, 'UPDATE models SET enabled = ? WHERE name = ?;', [enabled ? 1 : 0, name]);
  }

  async setModelMaxContext(name: string, maxContext: number | null): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!, 'UPDATE models SET max_context = ? WHERE name = ?;', [maxContext, name]);
  }

  private mapModelRow(row: Record<string, any>): Model {
    let families: string[] | undefined;
    if (row.families) {
      try { families = JSON.parse(row.families); } catch { families = undefined; }
    }
    let capabilities: string[] | undefined;
    if (row.capabilities) {
      try { capabilities = JSON.parse(row.capabilities); } catch { capabilities = undefined; }
    }
    return {
      name: String(row.name),
      size: Number(row.size ?? 0),
      modified_at: String(row.modified_at ?? ''),
      digest: String(row.digest ?? ''),
      details: {
        family: row.family ?? undefined,
        families,
        parameter_size: row.parameter_size ?? undefined,
        quantization_level: row.quantization_level ?? undefined
      },
      capabilities,
      enabled: row.enabled === undefined ? true : !!row.enabled,
      contextLength: row.context_length != null ? Number(row.context_length) : undefined,
      maxContext: row.max_context != null ? Number(row.max_context) : null
    } as any;
  }

  // ---------------------------------------------------------------------------
  // Message CRUD — delegates to MessageRepository
  // ---------------------------------------------------------------------------

  async addMessage(record: MessageRecord): Promise<void> {
    this.ensureReady();
    return this._messages.addMessage(record);
  }

  async getMessagesBySession(sessionId: string): Promise<MessageRecord[]> {
    this.ensureReady();
    return this._messages.getMessagesBySession(sessionId);
  }

  async deleteSessionMessages(sessionId: string): Promise<void> {
    this.ensureReady();
    return this._messages.deleteSessionMessages(sessionId);
  }

  async getNextTimestamp(sessionId: string): Promise<number> {
    this.ensureReady();
    return this._messages.getNextTimestamp(sessionId);
  }

  async cleanupOrphanedMessages(): Promise<number> {
    this.ensureReady();
    return this._messages.cleanupOrphanedMessages();
  }

  async recreateMessagesTable(): Promise<void> {
    this.ensureReady();
    return this._messages.recreateMessagesTable();
  }

  // ---------------------------------------------------------------------------
  // Checkpoint CRUD — delegates to CheckpointRepository
  // ---------------------------------------------------------------------------

  async createCheckpoint(sessionId: string, messageId?: string): Promise<string> {
    this.ensureReady();
    return this._checkpoints.createCheckpoint(sessionId, messageId);
  }

  async getCheckpoints(sessionId: string) {
    this.ensureReady();
    return this._checkpoints.getCheckpoints(sessionId);
  }

  async updateCheckpointStatus(id: string, status: string): Promise<void> {
    this.ensureReady();
    return this._checkpoints.updateCheckpointStatus(id, status);
  }

  async updateCheckpointDiffStats(id: string, totalAdditions: number, totalDeletions: number): Promise<void> {
    this.ensureReady();
    return this._checkpoints.updateCheckpointDiffStats(id, totalAdditions, totalDeletions);
  }

  async getSessionsPendingStats() {
    this.ensureReady();
    return this._checkpoints.getSessionsPendingStats();
  }

  async insertFileSnapshot(checkpointId: string, filePath: string, originalContent: string | null, action: string): Promise<void> {
    this.ensureReady();
    return this._checkpoints.insertFileSnapshot(checkpointId, filePath, originalContent, action);
  }

  async getFileSnapshots(checkpointId: string) {
    this.ensureReady();
    return this._checkpoints.getFileSnapshots(checkpointId);
  }

  async getSnapshotForFile(checkpointId: string, filePath: string) {
    this.ensureReady();
    return this._checkpoints.getSnapshotForFile(checkpointId, filePath);
  }

  async updateFileSnapshotStatus(checkpointId: string, filePath: string, status: string): Promise<void> {
    this.ensureReady();
    return this._checkpoints.updateFileSnapshotStatus(checkpointId, filePath, status);
  }

  async updateFileSnapshotsDiffStats(checkpointId: string, fileStats: Array<{ path: string; additions: number; deletions: number }>): Promise<void> {
    this.ensureReady();
    return this._checkpoints.updateFileSnapshotsDiffStats(checkpointId, fileStats);
  }

  async pruneKeptCheckpointContent(checkpointId: string): Promise<void> {
    this.ensureReady();
    return this._checkpoints.pruneKeptCheckpointContent(checkpointId);
  }

  async getPendingCheckpoints() {
    this.ensureReady();
    return this._checkpoints.getPendingCheckpoints();
  }

  async deleteCheckpoints(sessionId: string): Promise<void> {
    this.ensureReady();
    return this._checkpoints.deleteCheckpoints(sessionId);
  }
}
