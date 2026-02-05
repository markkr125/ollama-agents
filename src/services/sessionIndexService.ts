import * as vscode from 'vscode';
import { ChatSessionStatus, SessionRecord, SessionsPage } from '../types/session';

export class SessionIndexService {
  private db: any | null = null;
  private initialized = false;
  private dbUri: vscode.Uri;
  private storageUri: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.storageUri = this.context.storageUri ?? this.context.globalStorageUri;
    this.dbUri = vscode.Uri.joinPath(this.storageUri, 'sessions.sqlite');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await vscode.workspace.fs.createDirectory(this.storageUri);

    // Use runtime require to avoid bundling issues
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({
      locateFile: (file: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'sql.js', 'dist', file).fsPath
    });

    let dbData: Uint8Array | undefined;
    try {
      const data = await vscode.workspace.fs.readFile(this.dbUri);
      if (data && data.length > 0) {
        dbData = data;
      }
    } catch {
      // No existing DB
    }

    this.db = new SQL.Database(dbData);

    this.db.run(`
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

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON sessions(updated_at DESC);
    `);

    await this.ensureStatusColumn();
    await this.ensureAutoApproveColumn();
    await this.ensureAutoApproveSensitiveEditsColumn();
    await this.ensureSensitiveFilePatternsColumn();

    this.initialized = true;
    await this.persist();
  }

  private ensureReady(): void {
    if (!this.initialized || !this.db) {
      throw new Error('SessionIndexService not initialized');
    }
  }

  private async persist(): Promise<void> {
    if (!this.db) return;
    const data = this.db.export();
    await vscode.workspace.fs.writeFile(this.dbUri, data);
  }

  private hasColumn(table: string, column: string): boolean {
    if (!this.db) return false;
    try {
      const result = this.db.exec(`PRAGMA table_info(${table});`);
      if (!result || result.length === 0) return false;
      const rows = result[0].values || [];
      return rows.some((row: any[]) => String(row[1]) === column);
    } catch (error) {
      console.error('Failed to check table column:', { table, column, error });
      return false;
    }
  }

  private async ensureStatusColumn(): Promise<void> {
    if (!this.db) return;
    if (this.hasColumn('sessions', 'status')) {
      return;
    }

    this.db.run(`ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'completed';`);
    this.db.run(`UPDATE sessions SET status = 'completed' WHERE status IS NULL OR status = '';`);
    await this.persist();
  }

  private async ensureAutoApproveColumn(): Promise<void> {
    if (!this.db) return;
    if (this.hasColumn('sessions', 'auto_approve_commands')) {
      return;
    }

    this.db.run('ALTER TABLE sessions ADD COLUMN auto_approve_commands INTEGER NOT NULL DEFAULT 0;');
    this.db.run('UPDATE sessions SET auto_approve_commands = 0 WHERE auto_approve_commands IS NULL;');
    await this.persist();
  }

  private async ensureAutoApproveSensitiveEditsColumn(): Promise<void> {
    if (!this.db) return;
    if (this.hasColumn('sessions', 'auto_approve_sensitive_edits')) {
      return;
    }

    this.db.run('ALTER TABLE sessions ADD COLUMN auto_approve_sensitive_edits INTEGER NOT NULL DEFAULT 0;');
    this.db.run('UPDATE sessions SET auto_approve_sensitive_edits = 0 WHERE auto_approve_sensitive_edits IS NULL;');
    await this.persist();
  }

  private async ensureSensitiveFilePatternsColumn(): Promise<void> {
    if (!this.db) return;
    if (this.hasColumn('sessions', 'sensitive_file_patterns')) {
      return;
    }

    this.db.run('ALTER TABLE sessions ADD COLUMN sensitive_file_patterns TEXT DEFAULT NULL;');
    await this.persist();
  }

  private mapRow(row: Record<string, any>): SessionRecord {
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

  async createSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    this.db.run(
      `INSERT INTO sessions (id, title, mode, model, status, auto_approve_commands, auto_approve_sensitive_edits, sensitive_file_patterns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        record.id,
        record.title,
        record.mode,
        record.model,
        record.status ?? 'completed',
        record.auto_approve_commands ? 1 : 0,
        record.auto_approve_sensitive_edits ? 1 : 0,
        record.sensitive_file_patterns ?? null,
        record.created_at,
        record.updated_at
      ]
    );
    await this.persist();
  }

  async upsertSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    this.db.run(
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
        record.id,
        record.title,
        record.mode,
        record.model,
        record.status ?? 'completed',
        record.auto_approve_commands ? 1 : 0,
        record.auto_approve_sensitive_edits ? 1 : 0,
        record.sensitive_file_patterns ?? null,
        record.created_at,
        record.updated_at
      ]
    );
    await this.persist();
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    this.ensureReady();
    const stmt = this.db.prepare(
      'SELECT id, title, mode, model, status, auto_approve_commands, auto_approve_sensitive_edits, sensitive_file_patterns, created_at, updated_at FROM sessions WHERE id = ? LIMIT 1;'
    );
    stmt.bind([id]);
    let result: SessionRecord | null = null;
    if (stmt.step()) {
      result = this.mapRow(stmt.getAsObject());
    }
    stmt.free();
    return result;
  }

  async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
    this.ensureReady();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.mode !== undefined) {
      fields.push('mode = ?');
      values.push(updates.mode);
    }
    if (updates.model !== undefined) {
      fields.push('model = ?');
      values.push(updates.model);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.auto_approve_commands !== undefined) {
      fields.push('auto_approve_commands = ?');
      values.push(updates.auto_approve_commands ? 1 : 0);
    }
    if (updates.auto_approve_sensitive_edits !== undefined) {
      fields.push('auto_approve_sensitive_edits = ?');
      values.push(updates.auto_approve_sensitive_edits ? 1 : 0);
    }
    if (updates.sensitive_file_patterns !== undefined) {
      fields.push('sensitive_file_patterns = ?');
      values.push(updates.sensitive_file_patterns);
    }

    const updatedAt = typeof updates.updated_at === 'number' ? updates.updated_at : Date.now();
    fields.push('updated_at = ?');
    values.push(updatedAt);

    const sql = `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?;`;
    values.push(id);
    this.db.run(sql, values);
    await this.persist();
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureReady();
    this.db.run('DELETE FROM sessions WHERE id = ?;', [id]);
    await this.persist();
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    this.ensureReady();
    const stmt = this.db.prepare(
      'SELECT id, title, mode, model, status, auto_approve_commands, auto_approve_sensitive_edits, sensitive_file_patterns, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?;'
    );
    stmt.bind([limit + 1, offset]);

    const rows: SessionRecord[] = [];
    while (stmt.step()) {
      rows.push(this.mapRow(stmt.getAsObject()));
    }
    stmt.free();

    const hasMore = rows.length > limit;
    const sessions = hasMore ? rows.slice(0, limit) : rows;
    const nextOffset = hasMore ? offset + limit : null;

    return { sessions, hasMore, nextOffset };
  }

  async listAllSessions(): Promise<SessionRecord[]> {
    this.ensureReady();
    const stmt = this.db.prepare(
      'SELECT id, title, mode, model, status, auto_approve_commands, auto_approve_sensitive_edits, sensitive_file_patterns, created_at, updated_at FROM sessions;'
    );
    const rows: SessionRecord[] = [];
    while (stmt.step()) {
      rows.push(this.mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  async resetGeneratingSessions(status: ChatSessionStatus = 'idle'): Promise<void> {
    this.ensureReady();
    this.db.run('UPDATE sessions SET status = ? WHERE status = ?;', [status, 'generating']);
    await this.persist();
  }

  async clearAllSessions(): Promise<void> {
    this.ensureReady();
    this.db.run('DELETE FROM sessions;');
    await this.persist();
    console.log('[SessionIndexService] All sessions cleared');
  }
}
