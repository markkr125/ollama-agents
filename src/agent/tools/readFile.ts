import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { resolveWorkspacePath } from './pathUtils';

/**
 * read_file — Read the contents of a file relative to the workspace.
 * Accepts `path`, `file`, or `filePath` as the argument name.
 */
export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file',
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

    try {
      const content = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(content);
    } catch (error: any) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }
};
