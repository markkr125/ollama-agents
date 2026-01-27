import * as vscode from 'vscode';

export interface CodeContext {
  prefix: string;
  suffix: string;
  languageId: string;
}

/**
 * Extract code context around cursor position
 */
export function extractContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxPrefixChars = 2000,
  maxSuffixChars = 1000
): CodeContext {
  const offset = document.offsetAt(position);
  const text = document.getText();

  // Get prefix (text before cursor)
  const prefixStart = Math.max(0, offset - maxPrefixChars);
  const prefix = text.substring(prefixStart, offset);

  // Get suffix (text after cursor)
  const suffixEnd = Math.min(text.length, offset + maxSuffixChars);
  const suffix = text.substring(offset, suffixEnd);

  return {
    prefix,
    suffix,
    languageId: document.languageId
  };
}

/**
 * Get current line and indentation
 */
export function getCurrentLineInfo(
  document: vscode.TextDocument,
  position: vscode.Position
): { line: string; indentation: string } {
  const line = document.lineAt(position.line);
  const lineText = line.text;
  const indentMatch = lineText.match(/^(\s*)/);
  const indentation = indentMatch ? indentMatch[1] : '';

  return {
    line: lineText,
    indentation
  };
}

/**
 * Check if cursor is at end of line
 */
export function isAtEndOfLine(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const line = document.lineAt(position.line);
  return position.character === line.text.length;
}

/**
 * Get surrounding context with line numbers
 */
export function getSurroundingLines(
  document: vscode.TextDocument,
  position: vscode.Position,
  linesBefore = 5,
  linesAfter = 5
): string {
  const startLine = Math.max(0, position.line - linesBefore);
  const endLine = Math.min(document.lineCount - 1, position.line + linesAfter);

  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const lineText = document.lineAt(i).text;
    const marker = i === position.line ? '→ ' : '  ';
    lines.push(`${marker}${i + 1}: ${lineText}`);
  }

  return lines.join('\n');
}
