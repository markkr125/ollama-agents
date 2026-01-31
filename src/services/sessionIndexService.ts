import * as vscode from 'vscode';
import { SessionRecord, SessionsPage } from '../types/session';

export class SessionIndexService {
  private db: any | null = null;
  private initialized = false;
  private dbUri: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.dbUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'sessions.sqlite');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);

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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON sessions(updated_at DESC);
    `);

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

  private mapRow(row: Record<string, any>): SessionRecord {
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      mode: String(row.mode ?? ''),
      model: String(row.model ?? ''),
      created_at: Number(row.created_at ?? 0),
      updated_at: Number(row.updated_at ?? 0)
    };
  }

  async createSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    this.db.run(
      `INSERT INTO sessions (id, title, mode, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [record.id, record.title, record.mode, record.model, record.created_at, record.updated_at]
    );
    await this.persist();
  }

  async upsertSession(record: SessionRecord): Promise<void> {
    this.ensureReady();
    this.db.run(
      `INSERT INTO sessions (id, title, mode, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         mode = excluded.mode,
         model = excluded.model,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at;`,
      [record.id, record.title, record.mode, record.model, record.created_at, record.updated_at]
    );
    await this.persist();
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    this.ensureReady();
    const stmt = this.db.prepare(
      'SELECT id, title, mode, model, created_at, updated_at FROM sessions WHERE id = ? LIMIT 1;'
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
      'SELECT id, title, mode, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?;'
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
      'SELECT id, title, mode, model, created_at, updated_at FROM sessions;'
    );
    const rows: SessionRecord[] = [];
    while (stmt.step()) {
      rows.push(this.mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }
}
