import * as vscode from 'vscode';
import { Tool } from '../../types/agent';

/**
 * find_symbol — Search for symbols (functions, classes, interfaces, variables)
 * by name across the entire workspace using the language server's symbol index.
 *
 * Much more targeted than text search because it queries the language server's
 * semantic index rather than raw file contents. E.g. searching "ChatView"
 * finds the class definition, not every comment mentioning it.
 */

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

export const findSymbolTool: Tool = {
  name: 'find_symbol',
  description: 'Search for symbols (functions, classes, interfaces, variables) by name across the entire workspace using the language server index. More targeted than text search — finds actual code definitions, not just any text match. Use to quickly locate a function or class without knowing which file it\'s in.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name or partial name to search for (e.g. "handleMessage", "Tool", "ChatView")' },
      maxResults: { type: 'number', description: 'Maximum number of results to return. Default: 20' }
    },
    required: ['query']
  },
  execute: async (params) => {
    const query = params.query;
    if (!query || typeof query !== 'string') {
      throw new Error('Missing required argument: query');
    }

    const maxResults = params.maxResults || 20;

    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider', query
    );

    if (!symbols || symbols.length === 0) {
      return `No symbols found matching "${query}". The language server may not be active or may not index this type of symbol.`;
    }

    // Deduplicate and sort by relevance (exact name match first, then prefix, then contains)
    const unique = symbols.slice(0, maxResults);
    const lowerQuery = query.toLowerCase();

    unique.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === lowerQuery ? 0 : 1;
      const bExact = bName === lowerQuery ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aPrefix = aName.startsWith(lowerQuery) ? 0 : 1;
      const bPrefix = bName.startsWith(lowerQuery) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return aName.localeCompare(bName);
    });

    const lines: string[] = [];
    lines.push(`Found ${unique.length} symbol${unique.length !== 1 ? 's' : ''} matching "${query}":\n`);

    for (const s of unique) {
      const relPath = vscode.workspace.asRelativePath(s.location.uri);
      const line = s.location.range.start.line + 1;
      const kind = symbolKindName(s.kind);
      const container = s.containerName ? ` (in ${s.containerName})` : '';
      lines.push(`${kind} ${s.name}${container}  — ${relPath}:${line}`);
    }

    return lines.join('\n');
  }
};
