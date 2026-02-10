import * as vscode from 'vscode';
import { Tool } from '../../types/agent';

/**
 * search_workspace — Search for text across workspace files.
 */
export const searchWorkspaceTool: Tool = {
  name: 'search_workspace',
  description: 'Search for text across workspace files',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Maximum results', default: 20 }
    },
    required: ['query']
  },
  execute: async (params, _context) => {
    const maxResults = params.maxResults || 20;
    const results = await vscode.workspace.findFiles('**/*', '**/node_modules/**', maxResults);

    const matches: string[] = [];

    for (const uri of results) {
      if (matches.length >= maxResults) { break; }

      try {
        const content = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(content);

        if (text.toLowerCase().includes(params.query.toLowerCase())) {
          const relativePath = vscode.workspace.asRelativePath(uri);
          matches.push(relativePath);
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found';
  }
};
