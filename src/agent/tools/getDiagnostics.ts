import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { resolveWorkspacePath } from './pathUtils';

/**
 * get_diagnostics — Get errors and warnings for a file from VS Code's
 * language service. Accepts `path`, `file`, or `filePath`.
 */
export const getDiagnosticsTool: Tool = {
  name: 'get_diagnostics',
  description: 'Get errors and warnings for a file',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      file: { type: 'string', description: 'Alternative: file path relative to workspace' }
    },
    required: []
  },
  execute: async (params, context) => {
    const relativePath = params.path || params.file || params.filePath;
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Missing required argument: path (file path relative to workspace)');
    }
    const filePath = resolveWorkspacePath(relativePath, context.workspace);
    const uri = vscode.Uri.file(filePath);

    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (diagnostics.length === 0) {
      return 'No issues found';
    }

    return diagnostics
      .map(d => `Line ${d.range.start.line + 1}: [${d.severity}] ${d.message}`)
      .join('\n');
  }
};
