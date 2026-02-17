import { MessageRecord } from '../../types/session';
import { dbAll, dbExec, dbGet, dbRun, SqliteDb } from './sqliteHelpers';

// ---------------------------------------------------------------------------
// MessageRepository — Message CRUD + monotonic timestamp generation
// ---------------------------------------------------------------------------

export class MessageRepository {
  // In-memory cache for getNextTimestamp fast-path
  private lastTimestamp = 0;
  private lastTimestampSessionId: string | null = null;

  constructor(private readonly db: () => SqliteDb) {}

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
      tool_calls: row.tool_calls ?? undefined,
      timestamp: Number(row.timestamp ?? 0)
    };
  }

  async addMessage(record: MessageRecord): Promise<void> {
    await dbRun(this.db(),
      `INSERT INTO messages (id, session_id, role, content, model, tool_name, tool_input, tool_output, progress_title, tool_calls, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        record.id, record.session_id, record.role, record.content ?? '',
        record.model ?? null, record.tool_name ?? null,
        record.tool_input ?? null, record.tool_output ?? null,
        record.progress_title ?? null, record.tool_calls ?? null,
        record.timestamp
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
    const rows = await dbAll(this.db(),
      'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC;',
      [sessionId]
    );
    return rows.map(r => this.mapMessageRow(r));
  }

  async deleteSessionMessages(sessionId: string): Promise<void> {
    await dbRun(this.db(), 'DELETE FROM messages WHERE session_id = ?;', [sessionId]);
  }

  /**
   * Returns a strictly increasing timestamp for the given session.
   * Uses an in-memory cache to avoid DB queries on every call within
   * the same session; queries the DB on first call or session switch.
   */
  async getNextTimestamp(sessionId: string): Promise<number> {
    // On session switch or first call, seed from DB
    if (sessionId !== this.lastTimestampSessionId) {
      const row = await dbGet(this.db(),
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
    const orphans = await dbAll(this.db(),
      `SELECT m.id FROM messages m
       LEFT JOIN sessions s ON m.session_id = s.id
       WHERE s.id IS NULL;`
    );
    if (orphans.length > 0) {
      await dbRun(this.db(),
        'DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions);'
      );
    }
    return orphans.length;
  }

  /**
   * Drop and recreate the messages table.
   */
  async recreateMessagesTable(): Promise<void> {
    await dbExec(this.db(), 'DROP TABLE IF EXISTS messages;');
    await dbExec(this.db(), `
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
    await dbExec(this.db(), `
      CREATE INDEX IF NOT EXISTS idx_messages_session_ts
      ON messages(session_id, timestamp);
    `);
    this.lastTimestamp = 0;
    this.lastTimestampSessionId = null;
    console.log('[MessageRepository] Messages table recreated');
  }
}
