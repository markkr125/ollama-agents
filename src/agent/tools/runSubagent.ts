import { Tool } from '../../types/agent';

/**
 * run_subagent — Launch a sub-agent to handle complex, multi-step read-only tasks.
 *
 * The sub-agent runs an independent exploration loop with its own tool calls
 * (read_file, search_workspace, list_files, code intelligence tools).
 * It returns the accumulated findings as a single text result.
 *
 * Inspired by Claude Code's `Task` tool — useful for:
 * - Researching code patterns across the codebase
 * - Security/quality review of specific areas
 * - Exploring unfamiliar parts of the project
 * - Parallel investigation of independent questions
 *
 * The sub-agent is read-only and cannot write files, run terminal commands,
 * or modify the workspace in any way.
 */
export const runSubagentTool: Tool = {
  name: 'run_subagent',
  description:
    'Launch a sub-agent to perform a complex, multi-step read-only task. ' +
    'The sub-agent can use all code intelligence tools (read files, search, find definitions, etc.) ' +
    'to explore the codebase and return findings. Use this when a task requires multiple tool calls ' +
    'to research or investigate, and the results can be summarized as text. ' +
    'The sub-agent is read-only — it cannot write files or run commands.',
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'A detailed description of the task for the sub-agent to perform. ' +
          'Be specific about what to investigate, what files to look at, and what information to return.'
      },
      mode: {
        type: 'string',
        enum: ['explore', 'review'],
        description: 'The mode for the sub-agent. "explore" (default) for general codebase exploration, ' +
          '"review" for security and quality review.'
      }
    },
    required: ['task']
  },
  execute: async (params, context) => {
    const task = params.task;
    if (!task || typeof task !== 'string') {
      return 'Error: "task" parameter is required and must be a string.';
    }
    const mode = (params.mode === 'review' ? 'review' : 'explore') as 'explore' | 'review';

    if (!context.runSubagent) {
      return 'Error: Sub-agent execution is not available in this context.';
    }

    try {
      const result = await context.runSubagent(task, mode);
      return result || '(Sub-agent returned no findings.)';
    } catch (error: any) {
      return `Sub-agent error: ${error.message || 'Unknown error'}`;
    }
  }
};
