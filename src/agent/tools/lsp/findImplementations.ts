import * as vscode from 'vscode';
import { Tool } from '../../../types/agent';
import { formatLocation, resolveSymbolPosition } from './symbolResolver';

/**
 * find_implementations — Find concrete implementations of an interface,
 * abstract class, or method using the active language server.
 *
 * E.g. given an interface `IMessageHandler`, returns all classes that
 * implement it. Given an abstract method, returns all overrides.
 */
export const findImplementationsTool: Tool = {
  name: 'find_implementations',
  description: 'Find concrete implementations of an interface, abstract class, or abstract method. Uses the language server to find all classes/methods that implement or override the target. Provide a file path and either a symbol name or line/character position.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace where the interface/abstract symbol is defined' },
      symbolName: { type: 'string', description: 'Name of the interface, abstract class, or method to find implementations of' },
      line: { type: 'number', description: 'Line number (1-based) of the symbol' },
      character: { type: 'number', description: 'Column number (1-based) of the symbol' }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const { uri, position } = await resolveSymbolPosition(params, context.workspace, context.workspaceFolders);

    const locations = await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >('vscode.executeImplementationProvider', uri, position);

    if (!locations || locations.length === 0) {
      const symbol = params.symbolName || `position ${params.line}:${params.character}`;
      return `No implementations found for ${symbol}. It may be a concrete type (not an interface/abstract), or the language server doesn't support this query.`;
    }

    const results: string[] = [];
    const toShow = locations.slice(0, 15);
    for (const loc of toShow) {
      const formatted = await formatLocation(loc, 2);
      results.push(formatted);
    }

    const header = locations.length === 1
      ? '1 implementation:'
      : `${locations.length} implementation${locations.length > 15 ? 's (showing first 15)' : 's'}:`;

    return `${header}\n\n${results.join('\n\n')}`;
  }
};
