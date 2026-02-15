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
      const lines: string[] = [];
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
          lines.push(`📁 ${name}`);
        } else {
          try {
            const fileUri = vscode.Uri.joinPath(uri, name);
            const stat = await vscode.workspace.fs.stat(fileUri);
            lines.push(`📄 ${name}\t${stat.size}`);
          } catch {
            lines.push(`📄 ${name}`);
          }
        }
      }
      return lines.join('\n');
    } catch (error: any) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }
};
