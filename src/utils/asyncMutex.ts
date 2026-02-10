/**
 * A simple promise-chain based mutex.
 * Serialises access so only one async operation runs at a time.
 *
 * Usage:
 * ```ts
 * const mutex = new AsyncMutex();
 * const result = await mutex.runExclusive(async () => {
 *   // critical section
 *   return someValue;
 * });
 * ```
 */
export class AsyncMutex {
  private _lock: Promise<void> = Promise.resolve();

  /**
   * Run `fn` exclusively — waits for any prior call to finish first.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._lock;
    let release!: () => void;
    this._lock = new Promise<void>(r => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
