import { AgentControlPacket, AgentControlState } from '../../../types/agent';
import { ContinuationStrategy } from '../../../types/config';

const CONTROL_OPEN = '<agent_control>';
const CONTROL_CLOSE = '</agent_control>';

// ── Smart completion detection ──────────────────────────────────
// Pure function extracted for testability. Used by both executors.

export interface CompletionCheckInput {
  response: string;
  thinkingContent: string;
  hasWrittenFiles: boolean;
  consecutiveNoToolIterations: number;
}

export type CompletionAction = 'break_implicit' | 'break_consecutive' | 'continue';

/**
 * Determines whether the agent loop should break based on a no-tool response.
 *
 * Decision matrix:
 * - Truly empty (no text, no thinking) + files written → `break_implicit` (done)
 * - 2+ consecutive no-tool iterations → `break_consecutive` (fallback)
 * - Otherwise → `continue` (give model one more chance)
 */
export function checkNoToolCompletion(input: CompletionCheckInput): CompletionAction {
  const isTrulyEmpty = !input.response.trim() && !input.thinkingContent;

  if (isTrulyEmpty && input.hasWrittenFiles) {
    return 'break_implicit';
  }

  if (input.consecutiveNoToolIterations >= 2) {
    return 'break_consecutive';
  }

  return 'continue';
}

export type AgentLoopEvent = 'no_tools' | 'tool_results' | 'diagnostics_errors' | 'need_summary';

// ── Dynamic num_ctx sizing ────────────────────────────────────────
// Instead of sending the model's full context_length as num_ctx (which can be
// 128K-393K and forces Ollama to pre-allocate a massive KV cache), we size
// num_ctx dynamically based on the actual payload. This matches OpenWebUI's
// approach (which omits num_ctx entirely, letting Ollama default to 2048) but
// scales up as conversations grow — no user configuration needed.

/** Minimum num_ctx floor — ensures enough room for small prompts + response. */
const MIN_NUM_CTX = 4096;
/** Alignment bucket size — round up to nearest multiple for cleaner Ollama allocation. */
const NUM_CTX_ALIGNMENT = 2048;

/**
 * Compute a right-sized num_ctx based on what we're actually sending.
 *
 * Formula: `clamp(ceil_align(payloadTokens + numPredict + buffer), MIN, modelMax)`
 *
 * - `payloadTokens`: estimated tokens in messages + tool definitions
 * - `numPredict`: max tokens the model can generate (response headroom)
 * - `buffer`: 512 tokens for Ollama's internal overhead (BOS/EOS tokens, chat template wrapping)
 * - Result is rounded up to the next 2048 boundary for cleaner memory allocation
 * - Capped at the model's actual context window (or user-configured max)
 *
 * @param payloadEstTokens - Estimated token count of messages + tool definitions
 * @param numPredict - The num_predict (max response tokens) being sent
 * @param modelContextWindow - The model's max context window (detected or user-set)
 * @returns The num_ctx value to send to Ollama
 */
export function computeDynamicNumCtx(
  payloadEstTokens: number,
  numPredict: number,
  modelContextWindow: number
): number {
  const needed = payloadEstTokens + numPredict + 512; // payload + response room + buffer
  const aligned = Math.ceil(needed / NUM_CTX_ALIGNMENT) * NUM_CTX_ALIGNMENT;
  return Math.min(Math.max(aligned, MIN_NUM_CTX), modelContextWindow);
}

const CONTROL_STATE_TRANSITIONS: Record<AgentLoopEvent, AgentControlState> = {
  no_tools: 'need_tools',
  tool_results: 'need_tools',
  diagnostics_errors: 'need_fixes',
  need_summary: 'need_summary',
};

export function buildControlPacketMessage(
  packet: AgentControlPacket,
  strategy: ContinuationStrategy = 'minimal'
): string {
  const payload = normalizePacket(packet, strategy);
  return `${CONTROL_OPEN}${JSON.stringify(payload)}${CONTROL_CLOSE}`;
}

export function buildContinuationControlMessage(args: {
  state?: AgentControlState;
  iteration: number;
  maxIterations: number;
  strategy: ContinuationStrategy;
  filesChanged?: string[];
  toolResults?: string;
  note?: string;
}): string {
  const state = args.state || 'need_tools';
  const packet: AgentControlPacket = {
    state,
    iteration: args.iteration + 1,
    maxIterations: args.maxIterations,
    remainingIterations: args.maxIterations - args.iteration - 1,
    // NEVER include task here — it's already in the conversation as
    // messages[1]. Repeating it in every continuation floods the context
    // and causes models to re-plan from scratch (see Pitfall #38).
    filesChanged: normalizeFilesChanged(args.filesChanged),
    toolResults: args.toolResults,
    note: args.note,
  };
  return buildControlPacketMessage(packet, args.strategy);
}

export function buildLoopContinuationMessage(
  context: {
    iteration: number;
    maxIterations: number;
    strategy: ContinuationStrategy;
    task?: string;
    filesChanged?: unknown[];
    defaultNote?: string;
  },
  options?: {
    event?: AgentLoopEvent;
    state?: AgentControlState;
    toolResults?: string;
    note?: string;
  }
): string {
  const state = options?.state || (options?.event ? resolveControlState(options.event) : 'need_tools');
  const packet = buildContinuationControlMessage({
    state,
    iteration: context.iteration,
    maxIterations: context.maxIterations,
    strategy: context.strategy,
    filesChanged: normalizeFilesChanged(context.filesChanged),
    toolResults: options?.toolResults,
    note: options?.note ?? context.defaultNote,
  });
  // Append a high-recency natural-language directive AFTER the structured packet.
  // NO task reminder here — the full task is already in messages[1]. Adding a
  // truncated preview caused models to fixate on the incomplete snippet and
  // conclude "the user hasn't specified a request" instead of reading msg[1].
  return `${packet}\nProceed with tool calls or [TASK_COMPLETE].`;
}

export function resolveControlState(event: AgentLoopEvent): AgentControlState {
  return CONTROL_STATE_TRANSITIONS[event];
}

export function formatNativeToolResults(results: Array<{ tool_name: string; content: string }>): string {
  return results.map(r => `[${r.tool_name} result]\n${r.content}`).join('\n\n');
}

export function formatTextToolResults(results: string[]): string {
  return results.join('\n\n');
}

export function isCompletionSignaled(response: string, thinkingContent?: string): boolean {
  const completionSignal = `${response} ${thinkingContent || ''}`;
  const declaredState = parseControlState(completionSignal);
  const lower = completionSignal.toLowerCase();
  // ONLY accept the canonical [TASK_COMPLETE] signal.
  // Do NOT accept loose variants like 'task is complete' or '[end_of_exploration]'
  // — models use these to escape the loop after 0 tool calls.
  return (
    declaredState === 'complete' ||
    lower.includes('[task_complete]')
  );
}

export function parseControlState(text: string): AgentControlState | undefined {
  const payload = extractControlPayload(text);
  if (!payload || typeof payload.state !== 'string') return undefined;
  if (payload.state === 'need_tools' || payload.state === 'need_fixes' || payload.state === 'need_summary' || payload.state === 'complete') {
    return payload.state;
  }
  return undefined;
}

export function stripControlPackets(text: string): string {
  return text.replace(/<agent_control>[\s\S]*?<\/agent_control>/gi, '').trim();
}

function extractControlPayload(text: string): Record<string, any> | undefined {
  const start = text.lastIndexOf(CONTROL_OPEN);
  if (start < 0) return undefined;
  const end = text.indexOf(CONTROL_CLOSE, start);
  if (end < 0) return undefined;
  const raw = text.slice(start + CONTROL_OPEN.length, end).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizePacket(packet: AgentControlPacket, strategy: ContinuationStrategy): AgentControlPacket {
  if (strategy === 'full') {
    // Never forward the task field — it's already in the conversation.
    const { task: _discarded, ...rest } = packet;
    return rest;
  }

  if (strategy === 'standard') {
    return {
      state: packet.state,
      iteration: packet.iteration,
      maxIterations: packet.maxIterations,
      remainingIterations: packet.remainingIterations,
      note: packet.note ? trim(packet.note, 160) : undefined,
      toolResults: packet.toolResults ? trim(packet.toolResults, 320) : undefined,
      filesChanged: packet.filesChanged?.slice(0, 5),
    };
  }

  return {
    state: packet.state,
    iteration: packet.iteration,
    maxIterations: packet.maxIterations,
    remainingIterations: packet.remainingIterations,
    note: packet.note ? trim(packet.note, 120) : undefined,
  };
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function normalizeFilesChanged(filesChanged?: unknown[]): string[] | undefined {
  if (!filesChanged || filesChanged.length === 0) return undefined;
  const files = filesChanged.filter((p): p is string => typeof p === 'string');
  if (files.length === 0) return undefined;
  return Array.from(new Set<string>(files));
}

// ---------------------------------------------------------------------------
// Tool call summary — replaces the opaque '[Reasoning completed]' placeholder.
//
// When a thinking model produces thinking + tool_calls but no text content,
// we previously used '[Reasoning completed]' as the assistant content. This
// gave the model ZERO context about what it decided on previous iterations,
// causing it to re-derive the same plan and produce repetitive thinking.
//
// This function generates a brief, deterministic summary of the tool calls
// (e.g. "I searched for 'query' and read src/file.ts") which gives the model
// enough context to build on its previous actions without including the full
// thinking trace (which causes Pitfall #12 parroting).
// ---------------------------------------------------------------------------

/**
 * Generate a brief natural-language summary of tool calls for the assistant
 * content field. Returns `undefined` if no tool calls are provided.
 */
export function buildToolCallSummary(
  toolCalls: Array<{ name: string; args: Record<string, any> }>
): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  const descriptions = toolCalls.map(tc => {
    const a = tc.args || {};
    switch (tc.name) {
      case 'read_file':
        return `read ${shortPath(a.path || a.file)}`;
      case 'write_file':
      case 'create_file':
        return `wrote ${shortPath(a.path || a.file)}`;
      case 'search_workspace':
        return `searched for "${truncate(a.query, 60)}"`;
      case 'list_files':
        return `listed ${shortPath(a.path || a.directory || '.')}`;
      case 'run_terminal_command':
      case 'run_command':
        return `ran \`${truncate(a.command, 40)}\``;
      case 'get_diagnostics':
        return `checked diagnostics${a.path ? ` for ${shortPath(a.path)}` : ''}`;
      case 'get_document_symbols':
        return `checked symbols for ${shortPath(a.path || a.file)}`;
      case 'find_definition':
        return `looked up definition of ${a.symbol || a.name || '?'}`;
      case 'find_references':
        return `looked up references to ${a.symbol || a.name || '?'}`;
      case 'find_symbol':
        return `searched symbols for "${truncate(a.query || a.name, 40)}"`;
      case 'get_hover_info':
        return `checked hover info for ${a.symbol || a.name || '?'}`;
      case 'get_call_hierarchy':
        return `checked call hierarchy for ${a.symbol || a.name || '?'}`;
      case 'find_implementations':
        return `looked up implementations of ${a.symbol || a.name || '?'}`;
      case 'get_type_hierarchy':
        return `checked type hierarchy for ${a.symbol || a.name || '?'}`;
      case 'run_subagent':
        return `delegated a sub-task`;
      default:
        return `used ${tc.name}`;
    }
  });

  return `I ${descriptions.join(', then ')}.`;
}

function shortPath(p: string | undefined): string {
  if (!p) return '?';
  // Show at most last 2 segments
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return '…';
  return s.length <= max ? s : s.substring(0, max) + '…';
}
