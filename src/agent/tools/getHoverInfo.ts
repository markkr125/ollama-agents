import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { resolveSymbolPosition } from './symbolResolver';

/**
 * get_hover_info — Get type information, documentation, and signatures for
 * a symbol using the active language server's hover provider.
 *
 * Returns the type signature and JSDoc/docstring for any symbol without
 * having to navigate to type definition files.
 */

function formatHoverContent(hover: vscode.Hover): string {
  const parts: string[] = [];

  for (const content of hover.contents) {
    if (typeof content === 'string') {
      parts.push(content);
    } else if (content instanceof vscode.MarkdownString) {
      parts.push(content.value);
    } else if ('language' in content && 'value' in content) {
      // MarkedString { language, value }
      parts.push(`\`\`\`${content.language}\n${content.value}\n\`\`\``);
    }
  }

  return parts.join('\n\n');
}

export const getHoverInfoTool: Tool = {
  name: 'get_hover_info',
  description: 'Get type information, documentation, and signatures for a symbol at a specific position. Uses the language server\'s hover provider. Returns type signatures, JSDoc/docstrings, and parameter info without reading definition files. Provide a file path and either a symbol name or line/character position.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      symbolName: { type: 'string', description: 'Name of the symbol to get hover info for' },
      line: { type: 'number', description: 'Line number (1-based)' },
      character: { type: 'number', description: 'Column number (1-based)' }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const { uri, position } = await resolveSymbolPosition(params, context.workspace, context.workspaceFolders);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', uri, position
    );

    if (!hovers || hovers.length === 0) {
      const symbol = params.symbolName || `position ${params.line}:${params.character}`;
      return `No hover information available for ${symbol}. The language server may not provide hover data for this symbol.`;
    }

    const results: string[] = [];
    for (const hover of hovers) {
      const formatted = formatHoverContent(hover);
      if (formatted.trim()) {
        results.push(formatted);
      }
    }

    if (results.length === 0) {
      return 'Hover provider returned empty content.';
    }

    const symbol = params.symbolName || `line ${params.line}`;
    return `Hover info for ${symbol}:\n\n${results.join('\n\n---\n\n')}`;
  }
};
