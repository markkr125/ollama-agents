// ---------------------------------------------------------------------------
// Promise wrappers for @vscode/sqlite3 (callback-based API)
// ---------------------------------------------------------------------------

export type SqliteDb = {
  run(sql: string, params?: any[], callback?: (err: Error | null) => void): void;
  all(sql: string, params?: any[], callback?: (err: Error | null, rows: any[]) => void): void;
  get(sql: string, params?: any[], callback?: (err: Error | null, row: any) => void): void;
  exec(sql: string, callback?: (err: Error | null) => void): void;
  close(callback?: (err: Error | null) => void): void;
};

export function dbRun(db: SqliteDb, sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function dbAll(db: SqliteDb, sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

export function dbGet(db: SqliteDb, sql: string, params: any[] = []): Promise<any | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err: Error | null, row: any) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function dbExec(db: SqliteDb, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function dbClose(db: SqliteDb): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
