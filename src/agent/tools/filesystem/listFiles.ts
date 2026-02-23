import * as vscode from 'vscode';
import { Tool } from '../../../types/agent';
import { resolveMultiRootPath } from './pathUtils';

/**
 * list_files — List files in a directory relative to the workspace.
 */
export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files and subdirectories in a directory. Shows file sizes. Do NOT use run_terminal_command with ls/find/tree — use this tool instead. For the workspace root, call with no arguments.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace (empty for root)' }
    },
    required: []
  },
  execute: async (params, context) => {
    // In multi-root workspaces with no path specified, list all workspace roots
    if (!params.path) {
      const allFolders = context.workspaceFolders;
      if (allFolders && allFolders.length > 1) {
        const parts: string[] = ['Workspace folders:'];
        for (const folder of allFolders) {
          parts.push(`📁 ${folder.name}/  (${folder.uri.fsPath})`);
        }
        parts.push('\nTo list files in a specific folder, use: list_files path="<folder_name>"');
        return parts.join('\n');
      }
    }

    const dirPath = params.path
      ? resolveMultiRootPath(params.path, context.workspace, context.workspaceFolders)
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
