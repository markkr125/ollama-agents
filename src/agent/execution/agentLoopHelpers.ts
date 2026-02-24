import * as vscode from 'vscode';
import { getConfig } from '../../config/settings';
import { extractContextLength, ModelCapabilities } from '../../services/model/modelCompatibility';
import { OllamaClient } from '../../services/model/ollamaClient';
import { ChatRequest } from '../../types/ollama';
import { MessageRecord } from '../../types/session';
import { extractToolCalls } from '../../utils/toolCallParser';
import { AgentEventEmitter } from './agentEventEmitter';
import { estimateTokensByCategory } from './streaming/agentContextCompactor';
import { computeDynamicNumCtx } from './streaming/agentControlPlane';

// ---------------------------------------------------------------------------
// Shared agent-loop utility functions extracted from AgentChatExecutor and
// AgentExploreExecutor. All functions are pure or near-pure — they depend
// on their parameters, not on class state. This eliminates ~400 lines of
// duplicated code across the two executors without coupling them via
// inheritance.
//
// See the duplication analysis in the Step 2 refactoring notes for the
// full list of patterns and their extraction rationale.
// ---------------------------------------------------------------------------

// ── 1. Context Window Resolution ────────────────────────────────────────

/**
 * Resolve the model's context window length. Prefers the capabilities DB
 * cache, falls back to a live `/api/show` call, and finally to the user
 * config default.
 *
 * Mutates `capabilities` in place (adds `contextLength` if resolved).
 */
export async function resolveContextWindow(
  client: OllamaClient,
  model: string,
  capabilities: ModelCapabilities | undefined,
  useNativeTools: boolean,
  outputChannel: vscode.OutputChannel,
  tag: string
): Promise<ModelCapabilities | undefined> {
  if (capabilities?.contextLength) return capabilities;
  try {
    const showResp = await client.showModel(model);
    const detected = extractContextLength(showResp);
    if (detected) {
      if (!capabilities) {
        capabilities = { chat: true, fim: false, tools: useNativeTools, vision: false, embedding: false };
      }
      capabilities.contextLength = detected;
      outputChannel.appendLine(`[${tag}] Live /api/show detected context_length=${detected} for ${model}`);
    }
  } catch {
    outputChannel.appendLine(`[${tag}] Live /api/show failed for ${model} — using config default num_ctx`);
  }
  return capabilities;
}

// ── 2. Effective Context Window (Two-Tier Cap + Floor) ─────────────────

/**
 * Minimum context window in tokens. Tool-using agents need at least this much
 * to hold the system prompt, tool definitions, and a meaningful conversation.
 * If you change this, also update the JSDoc below and the "Context Window"
 * section in `extension-architecture.instructions.md`.
 */
export const MIN_CONTEXT_TOKENS = 8192;

/**
 * Computes the effective context window:
 *   floor (8 192) → detected/user default → ceiling (per-model or global cap).
 */
export function computeEffectiveContextWindow(
  capabilities: ModelCapabilities | undefined
): number {
  const detectedContextWindow = capabilities?.contextLength;
  const userContextWindow = getConfig().contextWindow || 16000;
  const rawContextWindow = detectedContextWindow || userContextWindow;
  const globalCap = getConfig().agent.maxContextWindow;
  const effectiveCap = capabilities?.maxContext ?? globalCap;
  return Math.max(MIN_CONTEXT_TOKENS, Math.min(rawContextWindow, effectiveCap));
}

// ── 3. Strip Thinking from History ─────────────────────────────────────

/**
 * Defensively strip `thinking` from all history messages before sending.
 * Per Ollama #10448 / Qwen3 docs: "No Thinking Content in History".
 */
export function stripThinkingFromHistory(messages: any[]): void {
  for (const msg of messages) {
    if ('thinking' in msg) {
      delete (msg as any).thinking;
    }
  }
}

// ── 4. Conversation History Filtering & Mapping ─────────────────────────

/**
 * Build the conversation history from persisted MessageRecords.
 *
 * Filters out `__ui__` tool messages, empty content, and maps records
 * to the Ollama ChatMessage format. When `useNativeTools` is true,
 * preserves `role:'tool'` with `tool_name`. When false (XML fallback),
 * wraps tool results in `role:'user'` and injects `[Called:]` descriptions
 * into assistant messages.
 */
export function buildConversationHistory(
  records: MessageRecord[],
  useNativeTools: boolean
): any[] {
  return records
    .filter(m => {
      if (m.tool_name === '__ui__') return false;
      if (m.role === 'tool') return !!m.content.trim();
      if (m.role === 'user' || m.role === 'assistant') return !!m.content.trim() || !!m.tool_calls;
      return false;
    })
    .map(m => {
      if (m.role === 'tool') {
        if (useNativeTools) {
          return { role: 'tool' as const, content: m.content, tool_name: m.tool_name || 'unknown' };
        }
        const toolName = m.tool_name || 'unknown';
        return { role: 'user' as const, content: `[${toolName} result]\n${m.content}` };
      }
      const msg: any = { role: m.role as 'user' | 'assistant', content: m.content };
      if (m.role === 'assistant' && m.tool_calls) {
        try {
          const parsed = JSON.parse(m.tool_calls);
          if (useNativeTools) {
            msg.tool_calls = parsed;
          } else {
            const descs = (parsed as Array<{ function?: { name?: string; arguments?: any } }>).map(tc => {
              const name = tc.function?.name || 'unknown';
              const args = tc.function?.arguments || {};
              const argParts = Object.entries(args)
                .filter(([k]) => k !== 'content')
                .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v.substring(0, 100)}"` : JSON.stringify(v)}`)
                .join(', ');
              return `${name}(${argParts})`;
            }).join(', ');
            msg.content = msg.content
              ? `${msg.content}\n\n[Called: ${descs}]`
              : `[Called: ${descs}]`;
          }
        } catch { /* ignore malformed JSON */ }
      }
      return msg;
    });
}

// ── 5. Diagnostic Logging: Iteration State ─────────────────────────────

/**
 * Dump the conversation state at each iteration start for debugging.
 * Logs message count, role breakdown, and per-message content preview.
 */
export function logIterationState(
  outputChannel: vscode.OutputChannel,
  tag: string,
  iteration: number,
  messages: any[]
): void {
  const totalContentChars = messages.reduce((sum: number, m: any) => sum + (m.content?.length || 0), 0);
  const roleCounts = messages.reduce((acc: Record<string, number>, m: any) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});
  const roleBreakdown = Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(', ');
  outputChannel.appendLine(`[${tag} Iteration ${iteration}] Messages: ${messages.length} (${roleBreakdown}) — ~${Math.round(totalContentChars / 4)} est. tokens`);

  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    const contentPreview = (m.content || '').substring(0, 120).replace(/\n/g, '\\n');
    const toolCallsInfo = m.tool_calls ? ` tool_calls:[${Array.isArray(m.tool_calls) ? m.tool_calls.length : '?'}]` : '';
    const toolNameInfo = (m as any).tool_name ? ` tool_name:${(m as any).tool_name}` : '';
    outputChannel.appendLine(`  [msg ${mi}] role=${m.role}${toolNameInfo}${toolCallsInfo} content(${(m.content || '').length})="${contentPreview}"`);
  }
}

// ── 6. Diagnostic Logging: Request Payload Sizes ────────────────────────

/**
 * Log request payload sizes for debugging slow models. On the first
 * iteration, also dumps the full system prompt.
 */
export function logRequestPayload(
  outputChannel: vscode.OutputChannel,
  tag: string,
  iteration: number,
  messages: any[],
  chatRequest: ChatRequest
): void {
  const sysMsg = messages[0]?.role === 'system' ? messages[0].content : '';
  const sysChars = sysMsg.length;
  const sysEstTokens = Math.round(sysChars / 4);
  const toolDefCount = chatRequest.tools?.length || 0;
  const toolDefChars = chatRequest.tools ? JSON.stringify(chatRequest.tools).length : 0;
  const toolDefEstTokens = Math.round(toolDefChars / 4);
  const totalChars = messages.reduce((s: number, m: any) => s + (m.content?.length || 0), 0);
  const totalEstTokens = Math.round(totalChars / 4);
  const opts = chatRequest.options || {};
  outputChannel.appendLine(
    `[${tag} Iteration ${iteration}] Request payload: system_prompt=${sysEstTokens}tok(${sysChars}ch), ` +
    `tool_defs=${toolDefEstTokens}tok(${toolDefChars}ch, ${toolDefCount} tools), ` +
    `total_messages=${totalEstTokens}tok(${totalChars}ch), ` +
    `num_ctx=${opts.num_ctx ?? '?'} (dynamic), num_predict=${opts.num_predict ?? '?'}, temp=${opts.temperature ?? '?'}`
  );
  if (iteration === 1) {
    outputChannel.appendLine(`[${tag} Iteration 1] === SYSTEM PROMPT START ===`);
    outputChannel.appendLine(sysMsg);
    outputChannel.appendLine(`[${tag} Iteration 1] === SYSTEM PROMPT END (${sysChars} chars, ~${sysEstTokens} tokens) ===`);
  }
}

// ── 7. Prompt Token Tracking & Truncation Detection ────────────────────

export interface PromptTokenResult {
  lastPromptTokens: number | undefined;
  truncationWarning: string;
}

/**
 * Track prompt tokens from the stream result and detect possible
 * truncation by comparing estimated vs actual token counts.
 */
export function trackPromptTokens(
  messages: any[],
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  contextWindow: number,
  outputChannel: vscode.OutputChannel,
  tag: string,
  iteration: number
): PromptTokenResult {
  if (promptTokens == null) {
    return { lastPromptTokens: undefined, truncationWarning: '' };
  }
  const sentChars = messages.reduce((sum: number, m: any) => sum + (m.content?.length || 0), 0);
  const sentEstTokens = Math.round(sentChars / 4);
  const sentMsgCount = messages.length;
  const actualPrompt = promptTokens;
  const ratio = sentEstTokens > 0 ? (actualPrompt / sentEstTokens) : 1;
  let truncationWarning = '';
  if (ratio < 0.5 && sentEstTokens > 1000) {
    truncationWarning = ` ⚠️ POSSIBLE TRUNCATION: sent ~${sentEstTokens} est. tokens (${sentMsgCount} msgs, ${sentChars} chars) but model only processed ${actualPrompt} prompt tokens (ratio=${ratio.toFixed(2)}). The server may be silently dropping messages!`;
  }
  outputChannel.appendLine(
    `[${tag} Iteration ${iteration}] Token usage: prompt=${actualPrompt}, completion=${completionTokens ?? '?'}, ` +
    `context_window=${contextWindow}, sent_est=${sentEstTokens}, sent_msgs=${sentMsgCount}, ratio=${ratio.toFixed(2)}${truncationWarning}`
  );
  return { lastPromptTokens: promptTokens, truncationWarning };
}

// ── 8. Token Usage Emission ────────────────────────────────────────────

/**
 * Emit token usage to the webview for the live indicator.
 */
export async function emitTokenUsage(
  events: AgentEventEmitter,
  messages: any[],
  toolDefCount: number,
  lastPromptTokens: number | undefined,
  completionTokens: number | undefined,
  contextWindow: number
): Promise<void> {
  const categories = estimateTokensByCategory(messages, toolDefCount, lastPromptTokens);
  const tokenPayload = {
    promptTokens: lastPromptTokens ?? categories.total,
    completionTokens,
    contextWindow,
    categories
  };
  await events.emit('tokenUsage', tokenPayload);
}

// ── 9. Thinking Echo De-duplication ────────────────────────────────────

/**
 * Remove response text that is a duplicate of thinking content.
 * Some models echo the thinking content back in the response field.
 * Returns the cleaned response.
 */
export function deduplicateThinkingEcho(
  response: string,
  thinkingContent: string
): string {
  if (!thinkingContent.trim() || !response.trim()) return response;
  const thinkTrimmed = thinkingContent.trim();
  const respTrimmed = response.trim();
  if (respTrimmed === thinkTrimmed ||
      respTrimmed.startsWith(thinkTrimmed) ||
      thinkTrimmed.startsWith(respTrimmed)) {
    return '';
  }
  return response;
}

// ── 10. Cancellation Thinking Persistence ──────────────────────────────

/**
 * Persist accumulated thinking content when the user cancels the agent.
 * Ensures thinking is recoverable on session reload.
 */
export async function persistCancellationThinking(
  events: AgentEventEmitter,
  thinkingContent: string,
  thinkingStartTime: number,
  lastThinkingTimestamp: number | undefined,
  thinkingCollapsed: boolean
): Promise<void> {
  const cancelThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
  if (!cancelThinking) return;
  const thinkingEndTime = lastThinkingTimestamp || Date.now();
  const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
  await events.persist('thinkingBlock', { content: cancelThinking, durationSeconds });
  if (!thinkingCollapsed) {
    events.post('collapseThinking', { durationSeconds });
  }
}

// ── 11. Thinking Block Persistence + Collapse ──────────────────────────

export interface ThinkingBlockOptions {
  isSubagent?: boolean;
  /** Accumulated sub-agent thinking string (for append). Only used when isSubagent=true. */
  accumulatedSubagentThinking?: string;
}

export interface ThinkingBlockResult {
  /** Updated accumulated sub-agent thinking (when isSubagent=true). */
  accumulatedSubagentThinking?: string;
}

/**
 * Persist a thinking block for a completed iteration.
 *
 * For non-sub-agent mode: persists to DB + emits collapseThinking.
 * For sub-agent mode: emits subagentThinking event and accumulates.
 */
export async function persistThinkingBlock(
  events: AgentEventEmitter,
  thinkingContent: string,
  thinkingStartTime: number,
  lastThinkingTimestamp: number | undefined,
  thinkingCollapsed: boolean,
  options: ThinkingBlockOptions = {}
): Promise<ThinkingBlockResult> {
  const displayThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
  if (!displayThinking) return {};

  const thinkingEndTime = lastThinkingTimestamp || Date.now();
  const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);

  if (!options.isSubagent) {
    await events.persist('thinkingBlock', { content: displayThinking, durationSeconds });
    if (!thinkingCollapsed) {
      events.post('collapseThinking', { durationSeconds });
    }
    return {};
  }

  // Sub-agent mode: emit subagentThinking and accumulate
  let accumulated = options.accumulatedSubagentThinking || '';
  if (accumulated) accumulated += '\n\n';
  accumulated += displayThinking;

  const thinkingPayload = { content: displayThinking, durationSeconds };
  await events.emit('subagentThinking', thinkingPayload);

  return { accumulatedSubagentThinking: accumulated };
}

// ── 12. Tool Call Parsing ──────────────────────────────────────────────

/**
 * Parse tool calls from either native API response or XML text.
 * @param knownToolNames  When provided, the bare-JSON fallback inside
 *   `extractToolCalls` rejects tool names not in this set — prevents
 *   false-positive matches from arbitrary JSON in the response.
 */
export function parseToolCalls(
  response: string,
  nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>,
  useNativeTools: boolean,
  knownToolNames?: Set<string>
): Array<{ name: string; args: any }> {
  if (useNativeTools && nativeToolCalls.length > 0) {
    return nativeToolCalls.map(tc => ({
      name: tc.function?.name || '',
      args: tc.function?.arguments || {}
    }));
  }
  return extractToolCalls(response, knownToolNames);
}

// ── 13. Recover Tool Call from Ollama Parse Error ──────────────────────

/**
 * Recover a tool call from an Ollama tool-parse error message.
 * Ollama fails when the model emits smart/curly/fullwidth quotes in JSON.
 * Extracts the raw JSON, replaces all Unicode quote variants with ASCII,
 * parses the result, and infers the tool name from argument keys.
 */
export function recoverToolCallFromError(
  errText: string,
  nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>,
  outputChannel: vscode.OutputChannel,
  tag: string,
  iteration: number
): { name: string; args: any } | null {
  const rawMatch = errText.match(/raw='(\{[\s\S]*?\})'/) ||
    errText.match(/raw='(\{[\s\S]*?)' *err=/) ||
    errText.match(/raw='(\{[\s\S]*\})/);
  if (!rawMatch) {
    outputChannel.appendLine(`[${tag}][Iteration ${iteration}] Recovery: no raw JSON found in error text`);
    return null;
  }
  const fixed = rawMatch[1].replace(
    /[\u201C\u201D\u201E\u201F\u2018\u2019\u201A\u201B\uFF02\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F\uFE41\uFE42\uFE43\uFE44]/g,
    '"'
  );
  try {
    const parsed = JSON.parse(fixed);
    let name = parsed?.name || parsed?.function?.name;
    let args = parsed?.arguments || parsed?.function?.arguments;
    if (!name) {
      args = parsed;
      const lastPartial = nativeToolCalls[nativeToolCalls.length - 1];
      name = lastPartial?.function?.name;
    }
    if (!name && args) {
      if ('query' in args && !('symbolName' in args)) name = 'search_workspace';
      else if ('path' in args && 'content' in args) name = 'write_file';
      else if ('command' in args) name = 'run_terminal_command';
      else if ('symbolName' in args && 'path' in args) name = 'find_definition';
      else if ('path' in args) name = 'read_file';
    }
    if (name && args) {
      outputChannel.appendLine(`[${tag}][Iteration ${iteration}] Recovered tool call: ${name}(${JSON.stringify(args)})`);
      return { name, args };
    }
    outputChannel.appendLine(`[${tag}][Iteration ${iteration}] Recovery: could not determine tool name from: ${JSON.stringify(parsed)}`);
    return null;
  } catch (e) {
    outputChannel.appendLine(`[${tag}][Iteration ${iteration}] Recovery JSON parse failed: ${e}`);
    return null;
  }
}

// ── 14. Fatal Error Handling ───────────────────────────────────────────

/**
 * Build a display-friendly error message and emit it via the event emitter.
 */
export async function buildAndEmitFatalError(
  events: AgentEventEmitter,
  error: any,
  model: string,
  phase: string,
  iteration: number,
  maxIterations: number,
  outputChannel: vscode.OutputChannel,
  tag: string,
  messages: any[]
): Promise<void> {
  const msgCount = messages.length;
  const errMsg = error.message || String(error);
  const errorClass = error.name && error.name !== 'Error' ? `[${error.name}] ` : '';
  const statusInfo = error.statusCode ? ` (HTTP ${error.statusCode})` : '';
  outputChannel.appendLine(
    `[${tag}] Fatal error at iteration ${iteration}/${maxIterations} (${msgCount} messages, phase: ${phase}): ${errorClass}${errMsg}${statusInfo}`
  );
  const displayError = `${errorClass}${errMsg}${statusInfo}\n_(model: ${model}, phase: ${phase}, iteration ${iteration}/${maxIterations})_`;
  await events.emit('showError', { message: displayError });
}

// ── 15. Context Compaction with UI Emission ────────────────────────────

export interface CompactAndEmitOptions {
  isSubagent?: boolean;
}

/**
 * Run context compaction if needed and emit a progress group to the UI.
 * Skips UI emission for sub-agents.
 *
 * Returns `true` if compaction occurred.
 */
export async function compactAndEmit(
  contextCompactor: { compactIfNeeded: (messages: any[], contextWindow: number, model: string, lastPromptTokens?: number) => Promise<any> },
  messages: any[],
  contextWindow: number,
  model: string,
  lastPromptTokens: number | undefined,
  events: AgentEventEmitter,
  outputChannel: vscode.OutputChannel,
  tag: string,
  iteration: number,
  options: CompactAndEmitOptions = {}
): Promise<boolean> {
  const compacted = await contextCompactor.compactIfNeeded(messages, contextWindow, model, lastPromptTokens);
  if (!compacted) return false;

  outputChannel.appendLine(
    `[${tag}][Iteration ${iteration}] Context compacted — ${compacted.summarizedMessages} messages summarized (${compacted.tokensBefore}→${compacted.tokensAfter} tokens).`
  );

  if (!options.isSubagent) {
    const savedTokens = compacted.tokensBefore - compacted.tokensAfter;
    const savedK = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}K` : String(savedTokens);
    await events.emit('startProgressGroup', { title: 'Summarizing conversation' });
    const action = {
      status: 'success' as const,
      icon: '📝',
      text: `Condensed ${compacted.summarizedMessages} messages — freed ~${savedK} tokens`,
      detail: `${compacted.tokensBefore} → ${compacted.tokensAfter} tokens`
    };
    await events.emit('showToolAction', action);
    await events.emit('finishProgressGroup', {});
  }

  return true;
}

// ── 16. Chat Request Building ──────────────────────────────────────────

export interface ModeConfig {
  temperature: number;
  maxTokens: number;
}

/**
 * Build a `ChatRequest` from messages, mode config, and context window.
 * Handles dynamic `num_ctx` sizing so Ollama doesn't pre-allocate a
 * massive KV cache.
 */
export function buildChatRequest(
  model: string,
  messages: any[],
  modeConfig: ModeConfig,
  contextWindow: number,
  useNativeTools: boolean,
  toolDefs: any[] | undefined,
  keepAlive?: string
): ChatRequest {
  const payloadChars = messages.reduce((s: number, m: any) => s + (m.content?.length || 0), 0);
  const toolDefCharsForCtx = toolDefs ? JSON.stringify(toolDefs).length : 0;
  const payloadEstTokens = Math.round((payloadChars + toolDefCharsForCtx) / 4);
  const numCtx = computeDynamicNumCtx(payloadEstTokens, modeConfig.maxTokens, contextWindow);

  const chatRequest: ChatRequest = {
    model,
    messages,
    ...(keepAlive ? { keep_alive: keepAlive } : {}),
    options: {
      temperature: modeConfig.temperature,
      num_predict: modeConfig.maxTokens,
      num_ctx: numCtx,
      stop: ['[TASK_COMPLETE]'],
    },
  };
  if (useNativeTools && toolDefs) {
    chatRequest.tools = toolDefs;
  }
  return chatRequest;
}

// ── 17. Assistant Message Building with Tool Calls ─────────────────────

/**
 * Build the assistant message for conversation history and persist it
 * to the database with tool_calls metadata.
 *
 * Delegates message construction to `ConversationHistory.addAssistantToolMessage()`
 * when a `ConversationHistory` is provided; falls back to raw `messages[]` push
 * for backward compatibility with `agentExploreExecutor` (which doesn't use
 * the ConversationHistory wrapper yet).
 *
 * Returns the assistant message object pushed into the history.
 */
export async function buildAndPersistAssistantToolMessage(
  toolCalls: Array<{ name: string; args: any }>,
  nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>,
  response: string,
  thinkingContent: string,
  useNativeTools: boolean,
  messages: any[],
  sessionId: string | undefined,
  databaseService: { addMessage: (sid: string, role: 'user' | 'assistant' | 'tool', content: string, opts: any) => Promise<any> },
  hasPersistedIterationText: boolean,
  model: string,
  toolSummary: string | undefined,
  history?: import('./conversationHistory').ConversationHistory
): Promise<any> {
  let assistantMsg: any;

  if (history) {
    // Delegate to ConversationHistory's typed method
    assistantMsg = history.addAssistantToolMessage({
      toolCalls, nativeToolCalls, response, thinkingContent, toolSummary
    });
  } else {
    // Fallback for explore executor (raw messages array)
    let assistantContent = toolSummary || response || (thinkingContent ? '[Reasoning completed]' : '');

    if (!useNativeTools && toolCalls.length > 0) {
      const callDescs = toolCalls.map(tc => {
        const argParts = Object.entries(tc.args || {})
          .filter(([k]) => k !== 'content')
          .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v.substring(0, 100)}"` : JSON.stringify(v)}`)
          .join(', ');
        return `${tc.name}(${argParts})`;
      }).join(', ');
      assistantContent = assistantContent
        ? `${assistantContent}\n\n[Called: ${callDescs}]`
        : `[Called: ${callDescs}]`;
    }

    assistantMsg = { role: 'assistant', content: assistantContent };
    if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
    messages.push(assistantMsg);
  }

  // Persist with tool_calls metadata for multi-turn history
  if (useNativeTools && nativeToolCalls.length > 0 && sessionId) {
    const serializedToolCalls = JSON.stringify(nativeToolCalls);
    const persistContent = hasPersistedIterationText ? '' : (response.trim() || '');
    await databaseService.addMessage(sessionId, 'assistant', persistContent, {
      model, toolCalls: serializedToolCalls
    });
  }

  return assistantMsg;
}
