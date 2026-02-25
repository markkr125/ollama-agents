import * as vscode from 'vscode';
import { Tool } from '../../../types/agent';

/**
 * find_files — Find files by name or glob pattern using VS Code's workspace API.
 *
 * Unlike search_workspace (which searches file *contents* via ripgrep),
 * this tool searches for files by *filename* using glob patterns.
 * Wraps `vscode.workspace.findFiles(globPattern, excludePattern)`.
 */
export const findFilesTool: Tool = {
  name: 'find_files',
  description: 'Find files by name or glob pattern. Returns matching file paths (max 50). Use this to locate files by name — use search_workspace to find text INSIDE files. Examples: "**/SearchController*.ts", "src/**/*.test.ts", "**/*.config.{js,ts}".',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths (e.g. "**/SearchController*.ts", "src/**/*.config.js")' },
      exclude: { type: 'string', description: 'Optional glob pattern to exclude (e.g. "**/node_modules/**"). Defaults to standard excludes.' }
    },
    required: ['pattern']
  },
  execute: async (params, _context) => {
    const pattern = params.pattern;
    if (!pattern || typeof pattern !== 'string') {
      throw new Error('Missing required argument: pattern (glob pattern to search for files)');
    }

    const excludePattern = params.exclude || '**/node_modules/**';
    const MAX_RESULTS = 50;

    const uris = await vscode.workspace.findFiles(pattern, excludePattern, MAX_RESULTS);

    if (uris.length === 0) {
      return `No files found matching "${pattern}"`;
    }

    const paths = uris.map(uri => vscode.workspace.asRelativePath(uri, false));
    paths.sort();

    const header = `Found ${paths.length} file${paths.length !== 1 ? 's' : ''} matching "${pattern}"${paths.length >= MAX_RESULTS ? ` (showing first ${MAX_RESULTS})` : ''}:`;
    return `${header}\n${paths.join('\n')}`;
  }
};
