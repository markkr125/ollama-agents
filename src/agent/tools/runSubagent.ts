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
    'Launch a read-only sub-agent to perform complex, multi-step research tasks. ' +
    'The sub-agent can search files, read code, find definitions, trace call hierarchies, and analyze patterns. ' +
    'It returns its findings as text — the findings are NOT shown to the user automatically. ' +
    'After receiving the sub-agent\'s result, YOU must act on those findings yourself ' +
    '(e.g., write files, summarize to the user, or use the information for your next step). ' +
    'The sub-agent CANNOT write files, run commands, or modify the workspace — it is strictly read-only.',
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'A detailed description of the task for the sub-agent to perform. ' +
          'Be specific about what to investigate, what files to look at, and what information to return.'
      },
      title: {
        type: 'string',
        description: 'A short (3-5 word) summary of what the sub-agent will do. ' +
          'Shown to the user as a progress label. Example: "Analyze auth middleware"'
      },
      context_hint: {
        type: 'string',
        description: 'Optional hint to focus the sub-agent — e.g. "start from src/auth/" or "look at the database schema". ' +
          'Prepended to the sub-agent system prompt to reduce unnecessary exploration.'
      },
      description: {
        type: 'string',
        description: 'A brief one-sentence description of what the sub-agent will investigate. ' +
          'Shown to the user alongside the title. Example: "Trace the SearchObject class hierarchy and its data flow"'
      },
      mode: {
        type: 'string',
        enum: ['explore', 'review', 'deep-explore'],
        description: 'The mode for the sub-agent. "explore" (default) for general codebase exploration, ' +
          '"review" for security and quality review, "deep-explore" for recursive depth-first code tracing.'
      }
    },
    required: ['task', 'title']
  },
  execute: async (params, context) => {
    const task = params.task;
    if (!task || typeof task !== 'string') {
      return 'Error: "task" parameter is required and must be a string.';
    }
    const title = params.title && typeof params.title === 'string' ? params.title : undefined;
    const description = params.description && typeof params.description === 'string' ? params.description : undefined;
    const contextHint = params.context_hint && typeof params.context_hint === 'string' ? params.context_hint : undefined;
    const validModes = ['explore', 'review', 'deep-explore'] as const;
    const mode = (validModes.includes(params.mode) ? params.mode : 'explore') as 'explore' | 'review' | 'deep-explore';

    if (!context.runSubagent) {
      return 'Error: Sub-agent execution is not available in this context.';
    }

    // Prepend context_hint to the task if provided
    const effectiveTask = contextHint ? `[Focus: ${contextHint}]\n\n${task}` : task;

    try {
      context.outputChannel.appendLine(`[run_subagent] Launching sub-agent: ${title || mode} — ${task.substring(0, 100)}`);
      const result = await context.runSubagent(effectiveTask, mode, contextHint, title, description);
      return result || '(Sub-agent returned no findings.)';
    } catch (error: any) {
      return `Sub-agent error: ${error.message || 'Unknown error'}`;
    }
  }
};
