import { dbAll, dbGet, dbRun, SqliteDb } from './sqliteHelpers';

// ---------------------------------------------------------------------------
// CheckpointRepository — Checkpoint + file snapshot CRUD
// ---------------------------------------------------------------------------

export class CheckpointRepository {
  constructor(private readonly db: () => SqliteDb) {}

  // -------------------------------------------------------------------------
  // Checkpoint CRUD
  // -------------------------------------------------------------------------

  async createCheckpoint(sessionId: string, messageId?: string): Promise<string> {
    const id = `ckpt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await dbRun(this.db(),
      'INSERT INTO checkpoints (id, session_id, message_id, status, created_at) VALUES (?, ?, ?, ?, ?);',
      [id, sessionId, messageId ?? null, 'pending', Date.now()]
    );
    return id;
  }

  async getCheckpoints(sessionId: string): Promise<Array<{ id: string; session_id: string; message_id: string | null; status: string; created_at: number }>> {
    const rows = await dbAll(this.db(),
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC;',
      [sessionId]
    );
    return rows.map(r => ({
      id: String(r.id),
      session_id: String(r.session_id),
      message_id: r.message_id ? String(r.message_id) : null,
      status: String(r.status ?? 'pending'),
      created_at: Number(r.created_at ?? 0)
    }));
  }

  async updateCheckpointStatus(id: string, status: string): Promise<void> {
    await dbRun(this.db(), 'UPDATE checkpoints SET status = ? WHERE id = ?;', [status, id]);
  }

  /**
   * Cache aggregate diff stats on a checkpoint after they've been computed.
   */
  async updateCheckpointDiffStats(id: string, totalAdditions: number, totalDeletions: number): Promise<void> {
    await dbRun(this.db(),
      'UPDATE checkpoints SET total_additions = ?, total_deletions = ? WHERE id = ?;',
      [totalAdditions, totalDeletions, id]
    );
  }

  /**
   * Get aggregate pending change stats per session (only sessions with pending/partial checkpoints).
   * Returns a map of session_id → { additions, deletions, fileCount }.
   */
  async getSessionsPendingStats(): Promise<Map<string, { additions: number; deletions: number; fileCount: number }>> {
    // Two-level aggregation:
    //   Inner: per-checkpoint — if any file has per-file stats, sum those
    //          (accurate after partial keep/undo); otherwise fall back to
    //          checkpoint-level cached totals (backward compat for old data).
    //   Outer: per-session — sum the checkpoint subtotals.
    const rows = await dbAll(this.db(),
      `SELECT sub.session_id,
              SUM(sub.additions) AS additions,
              SUM(sub.deletions) AS deletions,
              SUM(sub.file_count) AS file_count
       FROM (
         SELECT c.session_id,
                c.id AS checkpoint_id,
                CASE
                  WHEN SUM(CASE WHEN fs.additions IS NOT NULL THEN 1 ELSE 0 END) > 0
                  THEN SUM(COALESCE(fs.additions, 0))
                  ELSE COALESCE(c.total_additions, 0)
                END AS additions,
                CASE
                  WHEN SUM(CASE WHEN fs.deletions IS NOT NULL THEN 1 ELSE 0 END) > 0
                  THEN SUM(COALESCE(fs.deletions, 0))
                  ELSE COALESCE(c.total_deletions, 0)
                END AS deletions,
                COUNT(DISTINCT fs.file_path) AS file_count
         FROM checkpoints c
         INNER JOIN file_snapshots fs ON fs.checkpoint_id = c.id AND fs.file_status = 'pending'
         WHERE c.status IN ('pending', 'partial')
         GROUP BY c.session_id, c.id
       ) sub
       GROUP BY sub.session_id;`
    );
    const map = new Map<string, { additions: number; deletions: number; fileCount: number }>();
    for (const r of rows) {
      map.set(String(r.session_id), {
        additions: Number(r.additions ?? 0),
        deletions: Number(r.deletions ?? 0),
        fileCount: Number(r.file_count ?? 0)
      });
    }
    return map;
  }

  /**
   * Delete all checkpoints (and cascading snapshots) for a session.
   */
  async deleteCheckpoints(sessionId: string): Promise<void> {
    await dbRun(this.db(), 'DELETE FROM checkpoints WHERE session_id = ?;', [sessionId]);
  }

  // -------------------------------------------------------------------------
  // File snapshot CRUD
  // -------------------------------------------------------------------------

  /**
   * Insert a file snapshot (INSERT OR IGNORE — keeps the first/true original per checkpoint).
   */
  async insertFileSnapshot(checkpointId: string, filePath: string, originalContent: string | null, action: string): Promise<void> {
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await dbRun(this.db(),
      `INSERT OR IGNORE INTO file_snapshots (id, checkpoint_id, file_path, original_content, action, file_status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?);`,
      [id, checkpointId, filePath, originalContent, action, Date.now()]
    );
  }

  async getFileSnapshots(checkpointId: string): Promise<Array<{ id: string; checkpoint_id: string; file_path: string; original_content: string | null; action: string; file_status: string; created_at: number }>> {
    const rows = await dbAll(this.db(),
      'SELECT * FROM file_snapshots WHERE checkpoint_id = ? ORDER BY created_at ASC;',
      [checkpointId]
    );
    return rows.map(r => ({
      id: String(r.id),
      checkpoint_id: String(r.checkpoint_id),
      file_path: String(r.file_path),
      original_content: r.original_content != null ? String(r.original_content) : null,
      action: String(r.action ?? 'modified'),
      file_status: String(r.file_status ?? 'pending'),
      created_at: Number(r.created_at ?? 0)
    }));
  }

  async getSnapshotForFile(checkpointId: string, filePath: string): Promise<{ id: string; original_content: string | null; action: string; file_status: string } | null> {
    const row = await dbGet(this.db(),
      'SELECT * FROM file_snapshots WHERE checkpoint_id = ? AND file_path = ? LIMIT 1;',
      [checkpointId, filePath]
    );
    if (!row) return null;
    return {
      id: String(row.id),
      original_content: row.original_content != null ? String(row.original_content) : null,
      action: String(row.action ?? 'modified'),
      file_status: String(row.file_status ?? 'pending')
    };
  }

  async updateFileSnapshotStatus(checkpointId: string, filePath: string, status: string): Promise<void> {
    await dbRun(this.db(),
      'UPDATE file_snapshots SET file_status = ? WHERE checkpoint_id = ? AND file_path = ?;',
      [status, checkpointId, filePath]
    );
  }

  /**
   * Batch-update per-file diff stats on file_snapshots for a checkpoint.
   */
  async updateFileSnapshotsDiffStats(checkpointId: string, fileStats: Array<{ path: string; additions: number; deletions: number }>): Promise<void> {
    for (const f of fileStats) {
      await dbRun(this.db(),
        'UPDATE file_snapshots SET additions = ?, deletions = ? WHERE checkpoint_id = ? AND file_path = ?;',
        [f.additions, f.deletions, checkpointId, f.path]
      );
    }
  }

  /**
   * Prune original_content from kept checkpoints to free storage.
   * Metadata (path, action, file_status) is preserved for history display.
   */
  async pruneKeptCheckpointContent(checkpointId: string): Promise<void> {
    await dbRun(this.db(),
      'UPDATE file_snapshots SET original_content = NULL WHERE checkpoint_id = ?;',
      [checkpointId]
    );
  }

  /**
   * Get all checkpoints with pending/partial status and their snapshots.
   * Used on extension restart to restore file decoration badges.
   */
  async getPendingCheckpoints(): Promise<Array<{ checkpointId: string; sessionId: string; files: Array<{ file_path: string; file_status: string }> }>> {
    const checkpointRows = await dbAll(this.db(),
      `SELECT id, session_id FROM checkpoints WHERE status IN ('pending', 'partial');`
    );
    const results: Array<{ checkpointId: string; sessionId: string; files: Array<{ file_path: string; file_status: string }> }> = [];
    for (const ckpt of checkpointRows) {
      const snapshotRows = await dbAll(this.db(),
        `SELECT file_path, file_status FROM file_snapshots WHERE checkpoint_id = ? AND file_status = 'pending';`,
        [String(ckpt.id)]
      );
      results.push({
        checkpointId: String(ckpt.id),
        sessionId: String(ckpt.session_id),
        files: snapshotRows.map(r => ({ file_path: String(r.file_path), file_status: String(r.file_status) }))
      });
    }
    return results;
  }
}
