import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { readContextAroundLocation, resolveSymbolPosition } from './symbolResolver';

/**
 * find_references — Find all references to a symbol across the workspace
 * using the active language server. Returns every location where the symbol
 * is used, grouped by file, with context snippets.
 */
export const findReferencesTool: Tool = {
  name: 'find_references',
  description: 'Find all references (usages) of a function, class, variable, or any symbol across the entire workspace. Uses the language server for accurate cross-file results. Provide a file path and either a symbol name or line/character position.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace where the symbol is defined or referenced' },
      symbolName: { type: 'string', description: 'Name of the symbol to find references for' },
      line: { type: 'number', description: 'Line number (1-based) of the symbol' },
      character: { type: 'number', description: 'Column number (1-based) of the symbol' }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const { uri, position } = await resolveSymbolPosition(params, context.workspace, context.workspaceFolders);

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider', uri, position
    );

    if (!locations || locations.length === 0) {
      const symbol = params.symbolName || `position ${params.line}:${params.character}`;
      return `No references found for ${symbol}.`;
    }

    // Group by file
    const byFile = new Map<string, vscode.Location[]>();
    for (const loc of locations) {
      const relPath = vscode.workspace.asRelativePath(loc.uri);
      const existing = byFile.get(relPath) || [];
      existing.push(loc);
      byFile.set(relPath, existing);
    }

    const maxTotal = 30;
    let count = 0;
    const parts: string[] = [];
    parts.push(`Found ${locations.length} reference${locations.length !== 1 ? 's' : ''} across ${byFile.size} file${byFile.size !== 1 ? 's' : ''}:\n`);

    for (const [file, fileLocs] of byFile) {
      if (count >= maxTotal) {
        parts.push(`\n... and ${locations.length - count} more references (truncated)`);
        break;
      }

      parts.push(`── ${file} (${fileLocs.length} reference${fileLocs.length !== 1 ? 's' : ''}) ──`);

      for (const loc of fileLocs) {
        if (count >= maxTotal) break;
        const lineNum = loc.range.start.line;
        const contextStr = await readContextAroundLocation(loc.uri, lineNum, 1);
        parts.push(`  Line ${lineNum + 1}:`);
        parts.push(contextStr);
        parts.push('');
        count++;
      }
    }

    return parts.join('\n');
  }
};
