import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { resolveWorkspacePath } from './pathUtils';

/**
 * write_file — Write content to a file relative to the workspace.
 * Accepts `path`, `file`, or `filePath` as the argument name.
 */
export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      file: { type: 'string', description: 'Alternative: file path relative to workspace' },
      content: { type: 'string', description: 'Content to write' }
    },
    required: ['content']
  },
  execute: async (params, context) => {
    const relativePath = params.path || params.file || params.filePath;
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Missing required argument: path (file path relative to workspace)');
    }
    const filePath = resolveWorkspacePath(relativePath, context.workspace);
    const uri = vscode.Uri.file(filePath);

    try {
      const content = new TextEncoder().encode(params.content);
      await vscode.workspace.fs.writeFile(uri, content);
      return `Successfully wrote to ${relativePath}`;
    } catch (error: any) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }
};
