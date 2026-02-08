import * as vscode from 'vscode';
import { Model } from '../types/ollama';
import { ChatSessionStatus, MessageRecord, SessionRecord, SessionsPage } from '../types/session';

// ---------------------------------------------------------------------------
// Promise wrappers for @vscode/sqlite3 (callback-based API)
// ---------------------------------------------------------------------------

type SqliteDb = {
  run(sql: string, params?: any[], callback?: (err: Error | null) => void): void;
  all(sql: string, params?: any[], callback?: (err: Error | null, rows: any[]) => void): void;
  get(sql: string, params?: any[], callback?: (err: Error | null, row: any) => void): void;
  exec(sql: string, callback?: (err: Error | null) => void): void;
  close(callback?: (err: Error | null) => void): void;
};

function dbRun(db: SqliteDb, sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function dbAll(db: SqliteDb, sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

function dbGet(db: SqliteDb, sql: string, params: any[] = []): Promise<any | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err: Error | null, row: any) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbExec(db: SqliteDb, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function dbClose(db: SqliteDb): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// SessionIndexService — native SQLite via @vscode/sqlite3
// ---------------------------------------------------------------------------

export class SessionIndexService {
  private db: SqliteDb | null = null;
  private initialized = false;
  private storageUri: vscode.Uri;

  // In-memory cache for getNextTimestamp fast-path
  private lastTimestamp = 0;
  private lastTimestampSessionId: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.storageUri = this.context.storageUri ?? this.context.globalStorageUri;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await vscode.workspace.fs.createDirectory(this.storageUri);

    const dbPath = vscode.Uri.joinPath(this.storageUri, 'sessions.sqlite').fsPath;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
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

    this.initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
      await dbClose(this.db);
      this.db = null;
      this.initialized = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Session row mapper
  // ---------------------------------------------------------------------------

  private mapSessionRow(row: Record<string, any>): SessionRecord {
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      mode: String(row.mode ?? ''),
      model: String(row.model ?? ''),
      status: (String(row.status ?? 'completed') as ChatSessionStatus),
      auto_approve_commands: Boolean(row.auto_approve_commands ?? 0),
      auto_approve_sensitive_edits: Boolean(row.auto_approve_sensitive_edits ?? 0),
      sensitive_file_patterns: row.sensitive_file_patterns ?? null,
      created_at: Number(row.created_at ?? 0),
      updated_at: Number(row.updated_at ?? 0)
    };
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  async createSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!,
      `INSERT INTO sessions (id, title, mode, model, status, auto_approve_commands, auto_approve_sensitive_edits, sensitive_file_patterns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        record.id, record.title, record.mode, record.model,
        record.status ?? 'completed',
        record.auto_approve_commands ? 1 : 0,
        record.auto_approve_sensitive_edits ? 1 : 0,
        record.sensitive_file_patterns ?? null,
        record.created_at, record.updated_at
      ]
    );
  }

  async upsertSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!,
      `INSERT INTO sessions (id, title, mode, model, status, auto_approve_commands, auto_approve_sensitive_edits, sensitive_file_patterns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         mode = excluded.mode,
         model = excluded.model,
         status = excluded.status,
         auto_approve_commands = excluded.auto_approve_commands,
         auto_approve_sensitive_edits = excluded.auto_approve_sensitive_edits,
         sensitive_file_patterns = excluded.sensitive_file_patterns,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at;`,
      [
        record.id, record.title, record.mode, record.model,
        record.status ?? 'completed',
        record.auto_approve_commands ? 1 : 0,
        record.auto_approve_sensitive_edits ? 1 : 0,
        record.sensitive_file_patterns ?? null,
        record.created_at, record.updated_at
      ]
    );
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    this.ensureReady();
    const row = await dbGet(this.db!,
      'SELECT * FROM sessions WHERE id = ? LIMIT 1;',
      [id]
    );
    return row ? this.mapSessionRow(row) : null;
  }

  async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
    this.ensureReady();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.mode !== undefined) { fields.push('mode = ?'); values.push(updates.mode); }
    if (updates.model !== undefined) { fields.push('model = ?'); values.push(updates.model); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.auto_approve_commands !== undefined) {
      fields.push('auto_approve_commands = ?'); values.push(updates.auto_approve_commands ? 1 : 0);
    }
    if (updates.auto_approve_sensitive_edits !== undefined) {
      fields.push('auto_approve_sensitive_edits = ?'); values.push(updates.auto_approve_sensitive_edits ? 1 : 0);
    }
    if (updates.sensitive_file_patterns !== undefined) {
      fields.push('sensitive_file_patterns = ?'); values.push(updates.sensitive_file_patterns);
    }

    const updatedAt = typeof updates.updated_at === 'number' ? updates.updated_at : Date.now();
    fields.push('updated_at = ?');
    values.push(updatedAt);

    if (fields.length === 0) return;
    values.push(id);
    await dbRun(this.db!, `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?;`, values);
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureReady();
    // Messages are deleted via ON DELETE CASCADE (foreign_keys=ON)
    await dbRun(this.db!, 'DELETE FROM sessions WHERE id = ?;', [id]);
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    this.ensureReady();
    const rows = await dbAll(this.db!,
      'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?;',
      [limit + 1, offset]
    );

    const mapped = rows.map(r => this.mapSessionRow(r));
    const hasMore = mapped.length > limit;
    const sessions = hasMore ? mapped.slice(0, limit) : mapped;
    const nextOffset = hasMore ? offset + limit : null;
    return { sessions, hasMore, nextOffset };
  }

  async listAllSessions(): Promise<SessionRecord[]> {
    this.ensureReady();
    const rows = await dbAll(this.db!, 'SELECT * FROM sessions;');
    return rows.map(r => this.mapSessionRow(r));
  }

  async resetGeneratingSessions(status: ChatSessionStatus = 'idle'): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!, 'UPDATE sessions SET status = ? WHERE status = ?;', [status, 'generating']);
  }

  /**
   * Find an idle session with zero messages (for reuse instead of creating new).
   */
  async findIdleEmptySession(): Promise<string | null> {
    this.ensureReady();
    const row = await dbGet(this.db!,
      `SELECT s.id FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.status = 'idle'
       GROUP BY s.id
       HAVING COUNT(m.id) = 0
       ORDER BY s.updated_at DESC
       LIMIT 1;`
    );
    return row ? String(row.id) : null;
  }

  /**
   * Delete multiple sessions in a single statement (CASCADE handles messages).
   */
  async deleteMultipleSessions(ids: string[]): Promise<void> {
    this.ensureReady();
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await dbRun(this.db!, `DELETE FROM sessions WHERE id IN (${placeholders});`, ids);
  }

  async clearAllSessions(): Promise<void> {
    this.ensureReady();
    // CASCADE deletes messages too
    await dbRun(this.db!, 'DELETE FROM sessions;');
    console.log('[SessionIndexService] All sessions and messages cleared');
  }

  // ---------------------------------------------------------------------------
  // Model cache CRUD
  // ---------------------------------------------------------------------------

  /**
   * Upsert a batch of models from an Ollama API response.
   * Replaces the entire cache (deletes models no longer present).
   */
  async upsertModels(models: Model[]): Promise<void> {
    this.ensureReady();
    const now = Date.now();
    // Read existing enabled flags before replacing rows
    const existingRows = await dbAll(this.db!, 'SELECT name, enabled FROM models;');
    const enabledMap = new Map(existingRows.map(r => [String(r.name), Number(r.enabled ?? 1)]));
    await dbRun(this.db!, 'DELETE FROM models;');
    for (const m of models) {
      const enabled = m.enabled !== undefined ? (m.enabled ? 1 : 0) : (enabledMap.get(m.name) ?? 1);
      await dbRun(this.db!,
        `INSERT OR REPLACE INTO models (name, size, modified_at, digest, family, families, parameter_size, quantization_level, capabilities, enabled, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
          now
        ]
      );
    }
  }

  /**
   * Retrieve cached models from SQLite.
   * Returns Model[] matching the Ollama API shape so callers can use them interchangeably.
   */
  async getCachedModels(): Promise<Model[]> {
    this.ensureReady();
    const rows = await dbAll(this.db!, 'SELECT * FROM models ORDER BY name ASC;');
    return rows.map(r => this.mapModelRow(r));
  }

  async setModelEnabled(name: string, enabled: boolean): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!, 'UPDATE models SET enabled = ? WHERE name = ?;', [enabled ? 1 : 0, name]);
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
      enabled: row.enabled === undefined ? true : !!row.enabled
    };
  }

  // ---------------------------------------------------------------------------
  // Message CRUD
  // ---------------------------------------------------------------------------

  async addMessage(record: MessageRecord): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!,
      `INSERT INTO messages (id, session_id, role, content, model, tool_name, tool_input, tool_output, progress_title, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        record.id, record.session_id, record.role, record.content ?? '',
        record.model ?? null, record.tool_name ?? null,
        record.tool_input ?? null, record.tool_output ?? null,
        record.progress_title ?? null, record.timestamp
      ]
    );

    // Update the in-memory cache
    if (record.session_id === this.lastTimestampSessionId) {
      if (record.timestamp > this.lastTimestamp) {
        this.lastTimestamp = record.timestamp;
      }
    }
  }

  async getMessagesBySession(sessionId: string): Promise<MessageRecord[]> {
    this.ensureReady();
    const rows = await dbAll(this.db!,
      'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC;',
      [sessionId]
    );
    return rows.map(r => this.mapMessageRow(r));
  }

  async deleteSessionMessages(sessionId: string): Promise<void> {
    this.ensureReady();
    await dbRun(this.db!, 'DELETE FROM messages WHERE session_id = ?;', [sessionId]);
  }

  /**
   * Returns a strictly increasing timestamp for the given session.
   * Uses an in-memory cache to avoid DB queries on every call within
   * the same session; queries the DB on first call or session switch.
   */
  async getNextTimestamp(sessionId: string): Promise<number> {
    this.ensureReady();

    // On session switch or first call, seed from DB
    if (sessionId !== this.lastTimestampSessionId) {
      const row = await dbGet(this.db!,
        'SELECT MAX(timestamp) as max_ts FROM messages WHERE session_id = ?;',
        [sessionId]
      );
      this.lastTimestamp = row?.max_ts ?? 0;
      this.lastTimestampSessionId = sessionId;
    }

    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  /**
   * Delete messages that reference sessions not in the sessions table.
   */
  async cleanupOrphanedMessages(): Promise<number> {
    this.ensureReady();
    const orphans = await dbAll(this.db!,
      `SELECT m.id FROM messages m
       LEFT JOIN sessions s ON m.session_id = s.id
       WHERE s.id IS NULL;`
    );
    if (orphans.length > 0) {
      await dbRun(this.db!,
        'DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions);'
      );
    }
    return orphans.length;
  }

  /**
   * Drop and recreate the messages table.
   */
  async recreateMessagesTable(): Promise<void> {
    this.ensureReady();
    await dbExec(this.db!, 'DROP TABLE IF EXISTS messages;');
    await dbExec(this.db!, `
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
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
    await dbExec(this.db!, `
      CREATE INDEX IF NOT EXISTS idx_messages_session_ts
      ON messages(session_id, timestamp);
    `);
    this.lastTimestamp = 0;
    this.lastTimestampSessionId = null;
    console.log('[SessionIndexService] Messages table recreated');
  }

  // ---------------------------------------------------------------------------
  // Message row mapper
  // ---------------------------------------------------------------------------

  private mapMessageRow(row: Record<string, any>): MessageRecord {
    return {
      id: String(row.id),
      session_id: String(row.session_id),
      role: String(row.role) as 'user' | 'assistant' | 'tool',
      content: String(row.content ?? ''),
      model: row.model ?? undefined,
      tool_name: row.tool_name ?? undefined,
      tool_input: row.tool_input ?? undefined,
      tool_output: row.tool_output ?? undefined,
      progress_title: row.progress_title ?? undefined,
      timestamp: Number(row.timestamp ?? 0)
    };
  }
}
