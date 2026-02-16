import { ChatSessionStatus, SessionRecord, SessionsPage } from '../../types/session';
import { dbAll, dbGet, dbRun, SqliteDb } from './sqliteHelpers';

// ---------------------------------------------------------------------------
// SessionRepository — Session CRUD operations
// ---------------------------------------------------------------------------

export class SessionRepository {
  constructor(private readonly db: () => SqliteDb) {}

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

  async createSession(record: SessionRecord): Promise<void> {
    await dbRun(this.db(),
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
    await dbRun(this.db(),
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
    const row = await dbGet(this.db(),
      'SELECT * FROM sessions WHERE id = ? LIMIT 1;',
      [id]
    );
    return row ? this.mapSessionRow(row) : null;
  }

  async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
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
    await dbRun(this.db(), `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?;`, values);
  }

  async deleteSession(id: string): Promise<void> {
    await dbRun(this.db(), 'DELETE FROM sessions WHERE id = ?;', [id]);
  }

  async listSessions(limit = 50, offset = 0): Promise<SessionsPage> {
    const rows = await dbAll(this.db(),
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
    const rows = await dbAll(this.db(), 'SELECT * FROM sessions;');
    return rows.map(r => this.mapSessionRow(r));
  }

  async resetGeneratingSessions(status: ChatSessionStatus = 'idle'): Promise<void> {
    await dbRun(this.db(), 'UPDATE sessions SET status = ? WHERE status = ?;', [status, 'generating']);
  }

  async findIdleEmptySession(): Promise<string | null> {
    const row = await dbGet(this.db(),
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

  async deleteMultipleSessions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await dbRun(this.db(), `DELETE FROM sessions WHERE id IN (${placeholders});`, ids);
  }

  async clearAllSessions(): Promise<void> {
    await dbRun(this.db(), 'DELETE FROM sessions;');
    console.log('[SessionRepository] All sessions and messages cleared');
  }

  // ---- Session memory persistence ----

  async saveSessionMemory(sessionId: string, memoryJson: string): Promise<void> {
    await dbRun(this.db(),
      'UPDATE sessions SET session_memory = ?, updated_at = ? WHERE id = ?;',
      [memoryJson, Date.now(), sessionId]
    );
  }

  async loadSessionMemory(sessionId: string): Promise<string | null> {
    const row = await dbGet(this.db(),
      'SELECT session_memory FROM sessions WHERE id = ? LIMIT 1;',
      [sessionId]
    );
    return row?.session_memory ?? null;
  }
}
