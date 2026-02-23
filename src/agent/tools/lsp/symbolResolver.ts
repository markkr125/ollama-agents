import * as vscode from 'vscode';
import { resolveMultiRootPath } from '../filesystem/pathUtils';

/**
 * Shared utility for resolving a symbol name or line/character into a
 * precise `{ uri, position }` for use with VS Code language server commands.
 *
 * Multiple LSP-powered tools need this (find_definition, find_references,
 * get_hover_info, get_call_hierarchy). Centralised here to avoid duplication.
 */

export interface ResolvedLocation {
  uri: vscode.Uri;
  position: vscode.Position;
}

/**
 * Open a text document by path and resolve a { uri, position } from either
 * explicit line/character coordinates or a symbol name search.
 *
 * Resolution strategy:
 * 1. If `line` and `character` are both provided, use them directly.
 * 2. If `symbolName` is provided, search the document text for the symbol.
 *    - If `line` is also given, prefer the occurrence closest to that line.
 *    - Otherwise use the first occurrence.
 * 3. If only `line` is given (no character, no symbolName), use line with character 0.
 */
export async function resolveSymbolPosition(
  params: {
    path?: string;
    file?: string;
    filePath?: string;
    line?: number;
    character?: number;
    symbolName?: string;
  },
  workspace: vscode.WorkspaceFolder,
  allFolders?: readonly vscode.WorkspaceFolder[]
): Promise<ResolvedLocation> {
  const relativePath = params.path || params.file || params.filePath;
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Missing required argument: path (file path relative to workspace)');
  }

  const absPath = resolveMultiRootPath(relativePath, workspace, allFolders);
  const uri = vscode.Uri.file(absPath);

  // Open the document so the language server indexes it
  const document = await vscode.workspace.openTextDocument(uri);

  // Strategy 1: explicit line + character
  if (typeof params.line === 'number' && typeof params.character === 'number') {
    const pos = new vscode.Position(
      Math.max(0, params.line - 1), // convert 1-based to 0-based
      Math.max(0, params.character - 1)
    );
    return { uri, position: pos };
  }

  // Strategy 2: symbolName search
  if (params.symbolName && typeof params.symbolName === 'string') {
    const text = document.getText();
    const symbol = params.symbolName;

    // Find all occurrences
    const occurrences: vscode.Position[] = [];
    let searchStart = 0;
    while (true) {
      const idx = text.indexOf(symbol, searchStart);
      if (idx === -1) break;
      const pos = document.positionAt(idx);
      occurrences.push(pos);
      searchStart = idx + 1;
    }

    if (occurrences.length === 0) {
      // Fall back to case-insensitive search
      const lowerText = text.toLowerCase();
      const lowerSymbol = symbol.toLowerCase();
      let ciStart = 0;
      while (true) {
        const idx = lowerText.indexOf(lowerSymbol, ciStart);
        if (idx === -1) break;
        const pos = document.positionAt(idx);
        occurrences.push(pos);
        ciStart = idx + 1;
      }
    }

    if (occurrences.length === 0) {
      throw new Error(`Symbol "${symbol}" not found in ${relativePath}`);
    }

    // If a hint line is given, pick closest occurrence
    if (typeof params.line === 'number') {
      const targetLine = params.line - 1; // 0-based
      occurrences.sort((a, b) =>
        Math.abs(a.line - targetLine) - Math.abs(b.line - targetLine)
      );
    }

    return { uri, position: occurrences[0] };
  }

  // Strategy 3: line only (character defaults to 0)
  if (typeof params.line === 'number') {
    const pos = new vscode.Position(Math.max(0, params.line - 1), 0);
    return { uri, position: pos };
  }

  throw new Error('Provide either { line, character }, { symbolName }, or { line } to identify the symbol position');
}

/**
 * Read a few lines of context around a location from an open document.
 * Returns lines as a string with line numbers.
 */
export async function readContextAroundLocation(
  uri: vscode.Uri,
  line: number,
  contextLines: number = 3
): Promise<string> {
  const document = await vscode.workspace.openTextDocument(uri);
  const startLine = Math.max(0, line - contextLines);
  const endLine = Math.min(document.lineCount - 1, line + contextLines);

  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const prefix = i === line ? '→ ' : '  ';
    lines.push(`${prefix}${i + 1}: ${document.lineAt(i).text}`);
  }
  return lines.join('\n');
}

/**
 * Format a Location or LocationLink to a readable string with context.
 */
export async function formatLocation(
  location: vscode.Location | vscode.LocationLink,
  contextLines: number = 2
): Promise<string> {
  let uri: vscode.Uri;
  let range: vscode.Range;

  if ('targetUri' in location) {
    // LocationLink
    uri = location.targetUri;
    range = location.targetRange;
  } else {
    // Location
    uri = location.uri;
    range = location.range;
  }

  const relativePath = vscode.workspace.asRelativePath(uri);
  const line = range.start.line;

  const context = await readContextAroundLocation(uri, line, contextLines);
  return `${relativePath}:${line + 1}\n${context}`;
}
