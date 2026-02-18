import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { formatDiagnostics } from '../../utils/diagnosticWaiter';
import { resolveMultiRootPath } from './pathUtils';

/**
 * get_diagnostics — Get errors and warnings for a file from VS Code's
 * language service. Accepts `path`, `file`, or `filePath`.
 * When no path is given, returns workspace-wide diagnostics summary.
 */
export const getDiagnosticsTool: Tool = {
  name: 'get_diagnostics',
  description: 'Get errors and warnings from the language server for a file, or for all files if no path is given. This is automatically called after write_file — check the auto-diagnostics output before moving on. Do NOT use run_terminal_command to invoke a compiler/linter CLI — use this tool instead.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace. Omit to get workspace-wide diagnostics.' },
      file: { type: 'string', description: 'Alternative: file path relative to workspace' }
    },
    required: []
  },
  execute: async (params, context) => {
    const relativePath = params.path || params.file || params.filePath;

    // Workspace-wide diagnostics when no path given
    if (!relativePath || typeof relativePath !== 'string') {
      const allDiags = vscode.languages.getDiagnostics();
      const errorFiles: string[] = [];
      let totalErrors = 0;
      let totalWarnings = 0;

      for (const [uri, diags] of allDiags) {
        if (diags.length === 0) continue;
        const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
        totalErrors += errors.length;
        totalWarnings += warnings.length;
        if (errors.length > 0) {
          const relPath = vscode.workspace.asRelativePath(uri, false);
          errorFiles.push(`${relPath}: ${errors.length} error(s), ${warnings.length} warning(s)`);
        }
      }

      if (totalErrors === 0 && totalWarnings === 0) {
        return 'No issues found in workspace';
      }

      return `Workspace diagnostics: ${totalErrors} error(s), ${totalWarnings} warning(s)\n\n${errorFiles.join('\n')}`;
    }

    const filePath = resolveMultiRootPath(relativePath, context.workspace, context.workspaceFolders);
    const uri = vscode.Uri.file(filePath);

    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (diagnostics.length === 0) {
      return 'No issues found';
    }

    return formatDiagnostics(diagnostics);
  }
};
