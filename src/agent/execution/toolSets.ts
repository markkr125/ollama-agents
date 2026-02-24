/**
 * Centralised tool set definitions for all agent modes.
 *
 * Both the prompt builder (what tools the LLM is told about) and the
 * runtime executor (what tool calls are actually allowed) import from
 * here — guaranteeing they always stay in sync.
 *
 * ## Mode → Tool Set Mapping
 *
 * | Mode                | Set                  | Count | Extras vs READ_ONLY          |
 * |---------------------|----------------------|-------|------------------------------|
 * | explore / plan / chat | READ_ONLY_TOOLS    | 12    | — (baseline)                 |
 * | review (security)   | SECURITY_REVIEW_TOOLS| 13    | + run_terminal_command        |
 * | deep-explore        | DEEP_EXPLORE_TOOLS   | 13    | + run_subagent                |
 * | deep-explore-write  | ANALYZE_WRITE_TOOLS  | 14    | + run_subagent + write_file   |
 * | agent (orchestrator)| ORCHESTRATOR_TOOLS   | 3     | write_file, run_terminal_command, run_subagent only |
 */

/** 12 read-only code intelligence tools — baseline for explore/plan/chat modes. */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'search_workspace',
  'list_files',
  'get_diagnostics',
  'get_document_symbols',
  'find_definition',
  'find_references',
  'find_implementations',
  'find_symbol',
  'get_hover_info',
  'get_call_hierarchy',
  'get_type_hierarchy',
]);

/** Security review — read-only + terminal for running linters/scanners. */
export const SECURITY_REVIEW_TOOLS = new Set([...READ_ONLY_TOOLS, 'run_terminal_command']);

/** Deep explore — read-only + sub-agent for delegating independent exploration branches. */
export const DEEP_EXPLORE_TOOLS = new Set([...READ_ONLY_TOOLS, 'run_subagent']);

/** Analyze-with-write — deep exploration + write_file for documentation/report output. */
export const ANALYZE_WRITE_TOOLS = new Set([...DEEP_EXPLORE_TOOLS, 'write_file']);

/** Orchestrator — only write_file, run_terminal_command, run_subagent. All research delegated to sub-agents. */
export const ORCHESTRATOR_TOOLS = new Set([
  'write_file',
  'run_terminal_command',
  'run_subagent',
]);

// ---------------------------------------------------------------------------
// Mode → tool set resolution
// ---------------------------------------------------------------------------

/** All mode strings that map to a specific tool set. */
export type ToolMode =
  | 'explore' | 'plan' | 'chat'       // READ_ONLY_TOOLS
  | 'review'                           // SECURITY_REVIEW_TOOLS
  | 'deep-explore'                     // DEEP_EXPLORE_TOOLS
  | 'deep-explore-write'               // ANALYZE_WRITE_TOOLS
  | 'agent';                           // ORCHESTRATOR_TOOLS

/**
 * Resolve the allowed tool set for a given mode.
 * Centralises the mode→set mapping that was previously scattered across
 * `agentExploreExecutor.ts` (inline ternary) and `agentChatExecutor.ts`.
 */
export function getToolsForMode(mode: ToolMode): Set<string> {
  switch (mode) {
    case 'review':             return SECURITY_REVIEW_TOOLS;
    case 'deep-explore-write': return ANALYZE_WRITE_TOOLS;
    case 'deep-explore':       return DEEP_EXPLORE_TOOLS;
    case 'agent':              return ORCHESTRATOR_TOOLS;
    case 'explore':
    case 'plan':
    case 'chat':
    default:                   return READ_ONLY_TOOLS;
  }
}
