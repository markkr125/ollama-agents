// Debouncer utility for rate limiting

export class Debouncer {
  private timeoutId: NodeJS.Timeout | null = null;

  /**
   * Debounce a function call
   * @param fn Function to debounce
   * @param delay Delay in milliseconds
   */
  debounce<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
    return (...args: Parameters<T>) => {
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
      }

      this.timeoutId = setTimeout(() => {
        fn(...args);
        this.timeoutId = null;
      }, delay);
    };
  }

  /**
   * Cancel pending debounced call
   */
  cancel(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Check if there's a pending call
   */
  isPending(): boolean {
    return this.timeoutId !== null;
  }
}
