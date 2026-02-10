import { Tool } from '../../types/agent';

/**
 * run_terminal_command — Execute a shell command in the workspace terminal.
 */
export const runTerminalCommandTool: Tool = {
  name: 'run_terminal_command',
  description: 'Execute a shell command',
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

    const cwd = params.cwd || context.workspace.uri.fsPath;
    const result = await context.terminalManager.executeCommand(
      context.sessionId,
      params.command,
      cwd
    );

    return result.output;
  }
};
