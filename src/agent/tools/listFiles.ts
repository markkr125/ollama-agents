import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { resolveWorkspacePath } from './pathUtils';

/**
 * list_files — List files in a directory relative to the workspace.
 */
export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files in a directory',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace (empty for root)' }
    },
    required: []
  },
  execute: async (params, context) => {
    const dirPath = params.path
      ? resolveWorkspacePath(params.path, context.workspace)
      : context.workspace.uri.fsPath;

    const uri = vscode.Uri.file(dirPath);

    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries
        .map(([name, type]) => `${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`)
        .join('\n');
    } catch (error: any) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }
};
