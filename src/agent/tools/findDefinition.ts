import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { formatLocation, resolveSymbolPosition } from './symbolResolver';

/**
 * find_definition — Go to the definition of a symbol using the active
 * language server. This is the "go to definition" power — the agent can
 * follow a function call to its source code.
 *
 * Accepts a file path + either an explicit position (line/character) or a
 * symbol name to search for.
 */
export const findDefinitionTool: Tool = {
  name: 'find_definition',
  description: 'Go to the definition of a function, class, variable, or any symbol. Uses the language server to find where a symbol is defined, even across files. Provide a file path and either a symbol name or line/character position.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace where the symbol reference is located' },
      symbolName: { type: 'string', description: 'Name of the symbol to find the definition of (e.g. "handleMessage", "ToolContext")' },
      line: { type: 'number', description: 'Line number (1-based) of the symbol reference. Use with character or symbolName.' },
      character: { type: 'number', description: 'Column number (1-based) of the symbol reference. Use with line.' }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const { uri, position } = await resolveSymbolPosition(params, context.workspace, context.workspaceFolders);

    const locations = await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >('vscode.executeDefinitionProvider', uri, position);

    if (!locations || locations.length === 0) {
      const symbol = params.symbolName || `position ${params.line}:${params.character}`;
      return `No definition found for ${symbol}. The language server may not support this symbol or file type.`;
    }

    const results: string[] = [];
    // Show up to 5 definitions (usually 1, but can be more for overloads)
    const toShow = locations.slice(0, 5);
    for (const loc of toShow) {
      const formatted = await formatLocation(loc, 3);
      results.push(formatted);
    }

    const header = locations.length === 1
      ? 'Definition:'
      : `${locations.length} definition${locations.length > 5 ? 's (showing first 5)' : 's'}:`;

    return `${header}\n\n${results.join('\n\n')}`;
  }
};
