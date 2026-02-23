import * as vscode from 'vscode';
import { Tool } from '../../../types/agent';
import { resolveSymbolPosition } from './symbolResolver';

/**
 * get_type_hierarchy — Show the inheritance chain (supertypes and subtypes)
 * of a class or interface using the language server's type hierarchy provider.
 *
 * Useful for understanding inheritance: "what does this class extend?" and
 * "what classes extend this?".
 */

function symbolKindName(kind: vscode.SymbolKind): string {
  const names: Record<number, string> = {
    [vscode.SymbolKind.Class]: 'Class',
    [vscode.SymbolKind.Interface]: 'Interface',
    [vscode.SymbolKind.Enum]: 'Enum',
    [vscode.SymbolKind.Struct]: 'Struct',
    [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
    [vscode.SymbolKind.Method]: 'Method',
    [vscode.SymbolKind.Function]: 'Function',
  };
  return names[kind] || 'Symbol';
}

function formatHierarchyItem(item: vscode.TypeHierarchyItem, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const kind = symbolKindName(item.kind);
  const relPath = vscode.workspace.asRelativePath(item.uri);
  const line = item.range.start.line + 1;
  const detail = item.detail ? ` — ${item.detail}` : '';
  return `${prefix}${kind} ${item.name}${detail}  (${relPath}:${line})`;
}

export const getTypeHierarchyTool: Tool = {
  name: 'get_type_hierarchy',
  description: 'Show the inheritance chain of a class or interface: what it extends (supertypes) and what extends it (subtypes). Uses the language server\'s type hierarchy provider. Provide a file path and either a symbol name or line/character position.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      symbolName: { type: 'string', description: 'Name of the class or interface to get the type hierarchy for' },
      line: { type: 'number', description: 'Line number (1-based)' },
      character: { type: 'number', description: 'Column number (1-based)' },
      direction: { type: 'string', description: '"supertypes" (what does it extend?), "subtypes" (what extends it?), or "both". Default: "both"', enum: ['supertypes', 'subtypes', 'both'] }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const { uri, position } = await resolveSymbolPosition(params, context.workspace, context.workspaceFolders);
    const direction = params.direction || 'both';

    // Prepare the type hierarchy root
    const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
      'vscode.prepareTypeHierarchy', uri, position
    );

    if (!items || items.length === 0) {
      const symbol = params.symbolName || `position ${params.line}:${params.character}`;
      return `No type hierarchy available for ${symbol}. The language server may not support type hierarchy for this symbol or file type.`;
    }

    const rootItem = items[0];
    const parts: string[] = [];
    parts.push(`Type hierarchy for ${formatHierarchyItem(rootItem)}:\n`);

    // Supertypes: what does this type extend/implement?
    if (direction === 'supertypes' || direction === 'both') {
      const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
        'vscode.provideSupertypes', rootItem
      );

      parts.push('── Supertypes (extends/implements) ──');

      if (!supertypes || supertypes.length === 0) {
        parts.push('  No supertypes found.\n');
      } else {
        for (const st of supertypes.slice(0, 15)) {
          parts.push(formatHierarchyItem(st, 1));
        }
        if (supertypes.length > 15) {
          parts.push(`  ... and ${supertypes.length - 15} more`);
        }
        parts.push('');
      }
    }

    // Subtypes: what extends/implements this type?
    if (direction === 'subtypes' || direction === 'both') {
      const subtypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
        'vscode.provideSubtypes', rootItem
      );

      parts.push('── Subtypes (extended by / implemented by) ──');

      if (!subtypes || subtypes.length === 0) {
        parts.push('  No subtypes found.\n');
      } else {
        for (const st of subtypes.slice(0, 20)) {
          parts.push(formatHierarchyItem(st, 1));
        }
        if (subtypes.length > 20) {
          parts.push(`  ... and ${subtypes.length - 20} more`);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }
};
