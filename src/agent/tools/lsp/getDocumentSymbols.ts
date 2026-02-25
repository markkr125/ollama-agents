import * as vscode from 'vscode';
import { Tool } from '../../../types/agent';
import { resolveMultiRootPath } from '../filesystem/pathUtils';

/**
 * get_document_symbols — Get the outline (symbols) of a file using the
 * active language server. Returns all classes, functions, methods, variables,
 * interfaces, etc. with their kinds, line ranges, and nesting.
 *
 * This is the cheapest way to understand a file's structure without reading
 * every line — the agent sees an outline and can then read_file the specific
 * ranges it cares about.
 */

// ---------------------------------------------------------------------------
// Recursive symbol formatter
// ---------------------------------------------------------------------------

function symbolKindName(kind: vscode.SymbolKind): string {
  const names: Record<number, string> = {
    [vscode.SymbolKind.File]: 'File',
    [vscode.SymbolKind.Module]: 'Module',
    [vscode.SymbolKind.Namespace]: 'Namespace',
    [vscode.SymbolKind.Package]: 'Package',
    [vscode.SymbolKind.Class]: 'Class',
    [vscode.SymbolKind.Method]: 'Method',
    [vscode.SymbolKind.Property]: 'Property',
    [vscode.SymbolKind.Field]: 'Field',
    [vscode.SymbolKind.Constructor]: 'Constructor',
    [vscode.SymbolKind.Enum]: 'Enum',
    [vscode.SymbolKind.Interface]: 'Interface',
    [vscode.SymbolKind.Function]: 'Function',
    [vscode.SymbolKind.Variable]: 'Variable',
    [vscode.SymbolKind.Constant]: 'Constant',
    [vscode.SymbolKind.String]: 'String',
    [vscode.SymbolKind.Number]: 'Number',
    [vscode.SymbolKind.Boolean]: 'Boolean',
    [vscode.SymbolKind.Array]: 'Array',
    [vscode.SymbolKind.Object]: 'Object',
    [vscode.SymbolKind.Key]: 'Key',
    [vscode.SymbolKind.Null]: 'Null',
    [vscode.SymbolKind.EnumMember]: 'EnumMember',
    [vscode.SymbolKind.Struct]: 'Struct',
    [vscode.SymbolKind.Event]: 'Event',
    [vscode.SymbolKind.Operator]: 'Operator',
    [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
  };
  return names[kind] || 'Unknown';
}

function formatDocumentSymbols(symbols: vscode.DocumentSymbol[], indent: number = 0): string[] {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (const symbol of symbols) {
    const startLine = symbol.range.start.line + 1;
    const endLine = symbol.range.end.line + 1;
    const kind = symbolKindName(symbol.kind);
    const range = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
    const detail = symbol.detail ? ` — ${symbol.detail}` : '';

    lines.push(`${prefix}${kind} ${symbol.name} (${range})${detail}`);

    if (symbol.children && symbol.children.length > 0) {
      lines.push(...formatDocumentSymbols(symbol.children, indent + 1));
    }
  }

  return lines;
}

function formatSymbolInformation(symbols: vscode.SymbolInformation[]): string[] {
  return symbols.map(s => {
    const startLine = s.location.range.start.line + 1;
    const endLine = s.location.range.end.line + 1;
    const range = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
    const kind = symbolKindName(s.kind);
    const container = s.containerName ? ` (in ${s.containerName})` : '';
    return `${kind} ${s.name} (${range})${container}`;
  });
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const getDocumentSymbolsTool: Tool = {
  name: 'get_document_symbols',
  description: 'Get the outline (all symbols) of a file: classes, functions, methods, variables, interfaces, etc. with their line ranges and nesting. Uses the language server for accurate results. Much faster than reading an entire file when you just need to know its structure.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const relativePath = params.path || params.file || params.filePath;
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Missing required argument: path (file path relative to workspace)');
    }

    const absPath = resolveMultiRootPath(relativePath, context.workspace, context.workspaceFolders);
    const uri = vscode.Uri.file(absPath);

    // Open the document so the language server indexes it
    await vscode.workspace.openTextDocument(uri);

    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[] | vscode.SymbolInformation[]
    >('vscode.executeDocumentSymbolProvider', uri);

    if (!symbols || symbols.length === 0) {
      return `No symbols found in ${relativePath}. The language server may not be active for this file type.`;
    }

    // DocumentSymbol[] (hierarchical) vs SymbolInformation[] (flat)
    const isDocumentSymbol = (s: any): s is vscode.DocumentSymbol =>
      'children' in s && 'range' in s && !('location' in s);

    const lines = isDocumentSymbol(symbols[0])
      ? formatDocumentSymbols(symbols as vscode.DocumentSymbol[])
      : formatSymbolInformation(symbols as vscode.SymbolInformation[]);

    return `Symbols in ${relativePath}:\n${lines.join('\n')}`;
  }
};
