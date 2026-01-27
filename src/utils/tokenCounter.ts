// Token/character counting utilities

/**
 * Estimate tokens from text using character-based approximation
 * Roughly 1 token ≈ 4 characters for most languages
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Count characters in text
 */
export function countCharacters(text: string): number {
  return text.length;
}

/**
 * Truncate text to fit within character limit
 */
export function truncateToLimit(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.substring(0, maxChars);
}

/**
 * Calculate if text fits within limit
 */
export function fitsWithinLimit(text: string, maxChars: number): boolean {
  return text.length <= maxChars;
}
