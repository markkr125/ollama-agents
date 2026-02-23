import { Tool } from '../../types/agent';
import { resolveMultiRootPath } from './filesystem/pathUtils';

/**
 * run_terminal_command — Execute a shell command in the workspace terminal.
 */
export const runTerminalCommandTool: Tool = {
  name: 'run_terminal_command',
  description: `Execute a shell command in the workspace terminal. Use this for: running build/test/lint commands, installing packages, git operations, and any task that needs shell access.
Do NOT use this tool for tasks that have dedicated tools:
- Reading files: use read_file, not cat/head/tail
- Writing files: use write_file, not echo/heredoc/sed
- Searching code: use search_workspace, not grep/ripgrep/find
- Listing files: use list_files, not ls/find/tree
- Checking errors: use get_diagnostics, not compiler CLI
Before running commands, verify directory context (the default cwd is the workspace root). Quote all variable expansions. Prefer concise commands that produce structured output.`,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' },
      cwd: { type: 'string', description: 'Working directory relative to workspace root (leave empty for workspace root)' }
    },
    required: ['command']
  },
  execute: async (params, context) => {
    if (!context.terminalManager || !context.sessionId) {
      throw new Error('Terminal manager not available for this session.');
    }

    const cwd = params.cwd
      ? resolveMultiRootPath(params.cwd, context.workspace, context.workspaceFolders)
      : context.workspace.uri.fsPath;
    const result = await context.terminalManager.executeCommand(
      context.sessionId,
      params.command,
      cwd
    );

    return result.output;
  }
};
