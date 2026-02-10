// Diff parser utility for handling multiple diff formats

export type DiffFormat = 'unified-diff' | 'full-replacement' | 'code-block' | 'unknown';

export interface ParsedDiff {
  format: DiffFormat;
  content: string;
  language?: string;
}

/**
 * Detect the format of a diff/code response
 */
export function detectFormat(response: string): DiffFormat {
  // Check for unified diff format
  if (/^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(response)) {
    return 'unified-diff';
  }

  // Check for traditional diff format
  if (/^---\s+/m.test(response) && /^\+\+\+\s+/m.test(response)) {
    return 'unified-diff';
  }

  // Check for code blocks
  if (/^```[\w]*\n/m.test(response)) {
    return 'code-block';
  }

  // Default to full replacement
  return 'full-replacement';
}

/**
 * Extract code from fenced code blocks
 */
export function extractCodeBlock(text: string, preferredLanguage?: string): ParsedDiff | null {
  // Match fenced code blocks with optional language
  const codeBlockRegex = /```([\w]*)\n([\s\S]*?)```/g;
  const matches = Array.from(text.matchAll(codeBlockRegex));

  if (matches.length === 0) {
    return null;
  }

  // Prefer block with matching language, or take the last one
  let selectedMatch = matches[matches.length - 1];
  
  if (preferredLanguage) {
    const langMatch = matches.find(m => m[1].toLowerCase() === preferredLanguage.toLowerCase());
    if (langMatch) {
      selectedMatch = langMatch;
    }
  }

  return {
    format: 'code-block',
    content: selectedMatch[2].trim(),
    language: selectedMatch[1] || preferredLanguage
  };
}

/**
 * Parse unified diff format
 */
export function parseUnifiedDiff(diffText: string, originalCode: string): ParsedDiff {
  const lines = originalCode.split('\n');
  const diffLines = diffText.split('\n');

  let currentLine = 0;
  const newLines: string[] = [];

  for (const diffLine of diffLines) {
    // Parse hunk header
    const hunkMatch = diffLine.match(/^@@\s+-(\d+),(\d+)\s+\+(\d+),(\d+)\s+@@/);
    if (hunkMatch) {
      const startLine = parseInt(hunkMatch[1], 10) - 1;
      
      // Copy unchanged lines before this hunk
      while (currentLine < startLine) {
        newLines.push(lines[currentLine]);
        currentLine++;
      }
      continue;
    }

    // Handle diff lines
    if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
      // Addition
      newLines.push(diffLine.substring(1));
    } else if (diffLine.startsWith('-') && !diffLine.startsWith('---')) {
      // Deletion - skip line
      currentLine++;
    } else if (diffLine.startsWith(' ')) {
      // Unchanged context line
      newLines.push(diffLine.substring(1));
      currentLine++;
    }
  }

  // Copy remaining unchanged lines
  while (currentLine < lines.length) {
    newLines.push(lines[currentLine]);
    currentLine++;
  }

  return {
    format: 'unified-diff',
    content: newLines.join('\n')
  };
}

/**
 * Parse response and extract code
 */
export function parseEditResponse(
  response: string,
  originalCode: string,
  languageId?: string
): ParsedDiff {
  const format = detectFormat(response);

  switch (format) {
    case 'code-block': {
      const codeBlock = extractCodeBlock(response, languageId);
      return codeBlock || {
        format: 'full-replacement',
        content: response.trim(),
        language: languageId
      };
    }

    case 'unified-diff':
      return parseUnifiedDiff(response, originalCode);

    case 'full-replacement':
    default: {
      // Try to extract code block first
      const extracted = extractCodeBlock(response, languageId);
      if (extracted) {
        return extracted;
      }

      // Otherwise treat entire response as code
      return {
        format: 'full-replacement',
        content: response.trim(),
        language: languageId
      };
    }
  }
}

/**
 * Clean up response text (remove markdown, explanations, etc.)
 */
export function cleanResponseText(text: string): string {
  // Remove common prefixes
  text = text.replace(/^(Here'?s?|Here is) (the|a) (fixed|refactored|updated|modified) (code|version)[:\s]*/i, '');
  text = text.replace(/^(The )?[Ff]ixed code[:\s]*/i, '');
  text = text.replace(/^(The )?[Rr]efactored code[:\s]*/i, '');
  
  // Remove trailing explanations
  const codeBlockEnd = text.lastIndexOf('```');
  if (codeBlockEnd > 0) {
    const afterCodeBlock = text.substring(codeBlockEnd + 3).trim();
    if (afterCodeBlock.length < 100) {
      // Likely just a brief explanation, remove it
      text = text.substring(0, codeBlockEnd + 3);
    }
  }

  return text.trim();
}
