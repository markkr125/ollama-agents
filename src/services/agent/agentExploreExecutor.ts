import * as vscode from 'vscode';
import { ToolRegistry } from '../../agent/toolRegistry';
import { getConfig } from '../../config/settings';
import { ExecutorConfig } from '../../types/agent';
import { ChatRequest, OllamaError } from '../../types/ollama';
import { MessageRecord } from '../../types/session';
import { extractToolCalls, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { extractContextLength, ModelCapabilities } from '../model/modelCompatibility';
import { OllamaClient } from '../model/ollamaClient';
import { AgentContextCompactor, estimateTokensByCategory } from './agentContextCompactor';
import { AgentPromptBuilder } from './agentPromptBuilder';
import { AgentStreamProcessor } from './agentStreamProcessor';

// ---------------------------------------------------------------------------
// Text similarity helper — trigram-based Jaccard similarity.
// Detects when the model restates the same plan across iterations.
// Returns 0.0 (completely different) to 1.0 (identical).
// ---------------------------------------------------------------------------

function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 10 || nb.length < 10) return 0;

  // Trigram Jaccard similarity
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) {
      set.add(s.substring(i, i + 3));
    }
    return set;
  };

  const ta = trigrams(na);
  const tb = trigrams(nb);
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// Read-only tool names — only these tools are allowed in explore/plan modes.
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
  'get_document_symbols', 'find_definition', 'find_references',
  'find_implementations', 'find_symbol', 'get_hover_info',
  'get_call_hierarchy', 'get_type_hierarchy',
]);

// Deep explore adds run_subagent for delegating independent exploration branches
const DEEP_EXPLORE_TOOLS = new Set([...READ_ONLY_TOOLS, 'run_subagent']);

// ---------------------------------------------------------------------------
// AgentExploreExecutor — read-only exploration agent. Same streaming loop
// as AgentChatExecutor but restricted to read-only tools. No checkpoints,
// no approval flow, no file writes.
// ---------------------------------------------------------------------------

export type ExploreMode = 'explore' | 'plan' | 'review' | 'deep-explore' | 'chat';

export interface ExploreResult {
  summary: string;
  assistantMessage: MessageRecord;
}

export class AgentExploreExecutor {
  private readonly promptBuilder: AgentPromptBuilder;
  private readonly contextCompactor: AgentContextCompactor;
  private readonly streamProcessor: AgentStreamProcessor;

  constructor(
    private readonly client: OllamaClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly emitter: WebviewMessageEmitter
  ) {
    this.promptBuilder = new AgentPromptBuilder(this.toolRegistry);
    this.contextCompactor = new AgentContextCompactor(this.client);
    this.streamProcessor = new AgentStreamProcessor(this.client, this.emitter);
  }

  /**
   * Run the read-only exploration loop.
   *
   * @param mode - 'explore' for general exploration, 'plan' for structured planning, 'review' for security review
   */
  async execute(
    task: string,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    sessionId: string,
    model: string,
    mode: ExploreMode = 'explore',
    capabilities?: ModelCapabilities,
    conversationHistory?: MessageRecord[],
    isSubagent = false,
    primaryWorkspaceHint?: vscode.WorkspaceFolder
  ): Promise<ExploreResult> {
    const allFolders = vscode.workspace.workspaceFolders || [];
    const primaryWorkspace = primaryWorkspaceHint || allFolders[0];
    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();
    let useThinking = agentConfig.enableThinking && useNativeTools;

    // Resolve context window: capabilities DB > live /api/show > user config > Ollama default
    if (!capabilities?.contextLength) {
      try {
        const showResp = await this.client.showModel(model);
        const detected = extractContextLength(showResp);
        if (detected) {
          if (!capabilities) capabilities = { chat: true, fim: false, tools: useNativeTools, vision: false, embedding: false };
          capabilities.contextLength = detected;
          this.outputChannel.appendLine(`[AgentExploreExecutor] Live /api/show detected context_length=${detected} for ${model}`);
        }
      } catch {
        this.outputChannel.appendLine(`[AgentExploreExecutor] Live /api/show failed for ${model} — using config default num_ctx`);
      }
    }

    // Sub-agent mode: suppress all text streaming, thinking, and final message
    // emissions. Only tool UI (progress groups, tool actions) passes through.
    // This follows Claude Code's pattern: "The result returned by the agent
    // is not visible to the user."
    const emit = isSubagent
      ? (msg: any) => {
          const TOOL_UI_TYPES = new Set([
            'startProgressGroup', 'showToolAction', 'finishProgressGroup',
            'showError', 'showWarningBanner',
          ]);
          if (TOOL_UI_TYPES.has(msg.type)) this.emitter.postMessage(msg);
        }
      : (msg: any) => this.emitter.postMessage(msg);
    const silentEmitter: WebviewMessageEmitter = { postMessage: emit };
    const activeStreamProcessor = isSubagent
      ? new AgentStreamProcessor(this.client, silentEmitter)
      : this.streamProcessor;

    // Build mode-specific system prompt
    await this.promptBuilder.loadProjectContext(primaryWorkspace);
    const systemContent = this.buildSystemPrompt(mode, allFolders, primaryWorkspace, useNativeTools);

    // Build messages array with conversation history for multi-turn context.
    // CRITICAL: Include role:'tool' messages so the model sees its own prior
    // tool calls and results. Without these, the model loses memory of what
    // it already did and will restate plans and re-do searches each turn.
    const historyMessages = (conversationHistory || [])
      .filter(m => {
        if (m.tool_name === '__ui__') return false;
        if (m.role === 'tool') return !!m.content.trim();
        if (m.role === 'user' || m.role === 'assistant') return !!m.content.trim() || !!m.tool_calls;
        return false;
      })
      .map(m => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, content: m.content, tool_name: m.tool_name || 'unknown' };
        }
        const msg: any = { role: m.role as 'user' | 'assistant', content: m.content };
        if (m.role === 'assistant' && m.tool_calls) {
          try {
            msg.tool_calls = JSON.parse(m.tool_calls);
          } catch { /* ignore malformed JSON */ }
        }
        return msg;
      });

    const messages: any[] = [
      { role: 'system', content: systemContent },
      ...historyMessages,
      { role: 'user', content: task }
    ];

    if (!useNativeTools) {
      emit({
        type: 'showWarningBanner',
        message: 'This model doesn\'t natively support tool calling. Using text-based tool parsing.',
        sessionId
      });
    }

    // Per-mode iteration caps (lower than agent mode)
    const modeCaps: Record<string, number> = { review: 15, 'deep-explore': 20, plan: 10, chat: 10, explore: 10 };
    const maxIterations = Math.min(config.maxIterations, modeCaps[mode] || 10);
    let iteration = 0;
    let accumulatedExplanation = '';
    let hasPersistedIterationText = false;
    let consecutiveNoToolIterations = 0;
    let lastPromptTokens: number | undefined;

    // Loop detection: track previous iteration's tool call signatures
    let prevToolSignatures: string[] = [];
    let consecutiveDuplicateIterations = 0;

    // Text repetition detection
    let previousIterationText = '';
    let repetitionCorrectionNeeded = false;

    // Thinking/text repetition detection (SAFETY NET — not the primary fix).
    // The primary fix for thinking-model loops is injecting thinking content
    // into the assistant message's `content` field (see the push below).
    // These counters are a last-resort break if the model still loops.
    let previousThinkingContent = '';
    let consecutiveThinkingRepetitions = 0;
    let consecutiveTextRepetitions = 0;

    // Tool result cache: prevent re-executing identical read-only tool calls.
    // Key: `toolName:JSON(args)` → { output, iteration }
    const toolResultCache = new Map<string, { output: string; iteration: number }>();
    const CACHEABLE_TOOLS = new Set([
      'search_workspace', 'list_files', 'find_definition', 'find_references',
      'find_symbol', 'get_document_symbols', 'get_hover_info', 'get_call_hierarchy',
      'find_implementations', 'get_type_hierarchy', 'read_file',
    ]);

    // Track all tool calls made this session for the continuation summary
    const toolCallHistory: Array<{ name: string; query: string; resultSummary: string }> = [];

    while (iteration < maxIterations && !token.isCancellationRequested) {
      iteration++;
      repetitionCorrectionNeeded = false;

      // Diagnostic: log conversation state at each iteration start
      const totalContentChars = messages.reduce((sum: number, m: any) => sum + (m.content?.length || 0), 0);
      const roleCounts = messages.reduce((acc: Record<string, number>, m: any) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
      }, {});
      const roleBreakdown = Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(', ');
      this.outputChannel.appendLine(`[Explore Iteration ${iteration}] Messages: ${messages.length} (${roleBreakdown}) — ~${Math.round(totalContentChars / 4)} est. tokens — toolCallHistory: ${toolCallHistory.length} calls`);

      let phase = 'preparing request';

      try {
        // Context compaction for long explorations
        // contextWindow: detected model capacity (display-only) — used for
        //   compaction threshold and token usage UI. We do NOT send num_ctx
        //   to Ollama; let it manage its own KV cache.
        const detectedContextWindow = capabilities?.contextLength;
        const userContextWindow = getConfig().contextWindow || 16000;
        const contextWindow = detectedContextWindow || userContextWindow;
        if (iteration > 1) {
          const compacted = await this.contextCompactor.compactIfNeeded(messages, contextWindow, model, lastPromptTokens);
          if (compacted) {
            this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Context compacted — ${compacted.summarizedMessages} messages summarized.`);
            // Show visible indicator in the chat UI (skip for sub-agents)
            if (!isSubagent) {
              const savedTokens = compacted.tokensBefore - compacted.tokensAfter;
              const savedK = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}K` : String(savedTokens);
              await this.persistUiEvent(sessionId, 'startProgressGroup', { title: 'Summarizing conversation' });
              emit({ type: 'startProgressGroup', title: 'Summarizing conversation', sessionId });
              const action = { status: 'success' as const, icon: '📝', text: `Condensed ${compacted.summarizedMessages} messages — freed ~${savedK} tokens`, detail: `${compacted.tokensBefore} → ${compacted.tokensAfter} tokens` };
              await this.persistUiEvent(sessionId, 'showToolAction', action);
              emit({ type: 'showToolAction', ...action, sessionId });
              await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
              emit({ type: 'finishProgressGroup', sessionId });
            }
          }
        }

        // Build chat request — pick the mode-specific config for temperature/maxTokens
        const modeConfigMap: Record<string, 'chatMode' | 'planMode' | 'agentMode'> = {
          chat: 'chatMode', plan: 'planMode', explore: 'agentMode',
          'deep-explore': 'agentMode', review: 'agentMode',
        };
        const modeConfig = getConfig()[modeConfigMap[mode] || 'agentMode'];
        const chatRequest: ChatRequest = {
          model,
          messages,
          ...(agentConfig.keepAlive ? { keep_alive: agentConfig.keepAlive } : {}),
          options: {
            temperature: modeConfig.temperature,
            num_predict: modeConfig.maxTokens,
            stop: ['[TASK_COMPLETE]'],
          },
        };
        if (useNativeTools) {
          chatRequest.tools = this.getToolDefinitions(mode);
        }
        if (useThinking) {
          chatRequest.think = true;
        }

        if (iteration > 1) {
          emit({ type: 'iterationBoundary', sessionId });
        }

        phase = 'streaming response from model';
        const thinkingStartTime = Date.now();
        let streamResult;
        try {
          streamResult = await activeStreamProcessor.streamIteration(
            chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime
          );
        } catch (thinkErr: any) {
          if (useThinking && thinkErr instanceof OllamaError && thinkErr.statusCode === 400) {
            useThinking = false;
            delete chatRequest.think;
            streamResult = await activeStreamProcessor.streamIteration(
              chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime
            );
          } else {
            throw thinkErr;
          }
        }

        let { response } = streamResult;
        const { thinkingContent, nativeToolCalls, toolParseErrors } = streamResult;

        // --- Recover from Ollama tool-parse errors (smart/curly quotes) ---
        // Must happen BEFORE text processing — otherwise the error text leaks
        // into the UI as regular assistant chat text.
        let recoveredToolCalls: Array<{ name: string; args: any }> = [];
        if (toolParseErrors.length > 0 && useNativeTools) {
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Ollama tool-parse error(s) detected — attempting recovery`);
          for (const errText of toolParseErrors) {
            const recovered = this.recoverToolCallFromError(errText, nativeToolCalls, mode, iteration);
            if (recovered) {
              recoveredToolCalls.push(recovered);
            }
          }
        }

        // Update real token counts for context compactor (used next iteration)
        if (streamResult.promptTokens != null) {
          lastPromptTokens = streamResult.promptTokens;
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Token usage: prompt=${streamResult.promptTokens}, completion=${streamResult.completionTokens ?? '?'}, context_window=${contextWindow}`);
        }

        // Emit token usage to the webview for the live indicator
        if (!isSubagent) {
          const toolDefCount = useNativeTools ? this.getToolDefinitions(mode).length : 0;
          const categories = estimateTokensByCategory(messages, toolDefCount, lastPromptTokens);
          emit({
            type: 'tokenUsage',
            sessionId,
            promptTokens: lastPromptTokens ?? categories.total,
            completionTokens: streamResult.completionTokens,
            contextWindow,
            categories
          });
        }

        if (token.isCancellationRequested) {
          // Persist any accumulated thinking content before breaking so it
          // survives session restore.
          if (!isSubagent) {
            const cancelThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
            if (cancelThinking) {
              const thinkingEndTime = streamResult.lastThinkingTimestamp || Date.now();
              const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
              await this.persistUiEvent(sessionId, 'thinkingBlock', { content: cancelThinking, durationSeconds });
              if (!streamResult.thinkingCollapsed) {
                emit({ type: 'collapseThinking', sessionId, durationSeconds });
              }
            }
          }
          break;
        }

        // Log iteration
        this.outputChannel.appendLine(`\n[${mode}][Iteration ${iteration}] Response: ${response.substring(0, 300)}...`);

        // De-duplicate thinking echo
        if (thinkingContent.trim() && response.trim()) {
          const thinkTrimmed = thinkingContent.trim();
          const respTrimmed = response.trim();
          if (respTrimmed === thinkTrimmed || respTrimmed.startsWith(thinkTrimmed) || thinkTrimmed.startsWith(respTrimmed)) {
            response = '';
          }
        }

        // Persist thinking block (skip for sub-agents — their thinking is internal)
        if (!isSubagent) {
          const displayThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
          if (displayThinking) {
            const thinkingEndTime = streamResult.lastThinkingTimestamp || Date.now();
            const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
            await this.persistUiEvent(sessionId, 'thinkingBlock', { content: displayThinking, durationSeconds });
            if (!streamResult.thinkingCollapsed) {
              emit({ type: 'collapseThinking', sessionId, durationSeconds });
            }

            // --- Thinking repetition detection (SAFETY NET) ---
            // The primary fix for thinking-model loops is in the assistant
            // message push below (thinking content injected into `content`).
            // This detection is a last-resort safety net for pathological cases.
            if (previousThinkingContent) {
              const thinkSimilarity = textSimilarity(displayThinking, previousThinkingContent);
              if (thinkSimilarity > 0.6) {
                consecutiveThinkingRepetitions++;
                this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Thinking repetition detected (${Math.round(thinkSimilarity * 100)}% similar, streak: ${consecutiveThinkingRepetitions})`);
                repetitionCorrectionNeeded = true;

                if (consecutiveThinkingRepetitions >= 4) {
                  this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] HARD BREAK — ${consecutiveThinkingRepetitions} consecutive thinking repetitions`);
                  messages.push({ role: 'assistant', content: response || displayThinking.substring(0, 200) });
                  messages.push({
                    role: 'user',
                    content: 'STOP — you have repeated the same thinking/plan multiple times. You are stuck in a loop. Synthesize what you have so far and respond with [TASK_COMPLETE].'
                  });
                  break;
                }
              } else {
                consecutiveThinkingRepetitions = 0;
              }
            }
            previousThinkingContent = displayThinking;
          }
        }

        // Process text
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();

        if (iterationDelta) {
          // Repetition detection: inject corrective message but do NOT skip
          // tool execution — the model may have generated tool calls alongside
          // repetitive text. Using `continue` here would prevent progress.
          const similarity = previousIterationText.length > 0
            ? textSimilarity(iterationDelta, previousIterationText) : 0;
          const isRepetitiveText = similarity > 0.7;

          previousIterationText = iterationDelta;

          if (isRepetitiveText) {
            this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Repetitive text detected (${Math.round(similarity * 100)}% similar) — injecting correction, suppressing UI`);
            repetitionCorrectionNeeded = true;
            consecutiveTextRepetitions++;
            if (consecutiveTextRepetitions >= 5) {
              this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] HARD BREAK — ${consecutiveTextRepetitions} consecutive text repetitions`);
              break;
            }
          } else {
            consecutiveTextRepetitions = 0;
            if (accumulatedExplanation) accumulatedExplanation += '\n\n';
            accumulatedExplanation += iterationDelta;

            if (!isSubagent) {
              emit({ type: 'streamChunk', content: iterationDelta, model, sessionId });
              if (sessionId) {
                await this.databaseService.addMessage(sessionId, 'assistant', iterationDelta, { model });
                hasPersistedIterationText = true;
              }
            }
          }
        }

        // Check for completion
        if (response.includes('[TASK_COMPLETE]') || response.toLowerCase().includes('task is complete')) {
          break;
        }

        // Extract tool calls
        phase = 'parsing tool calls';
        let toolCalls = this.parseToolCalls(response, nativeToolCalls, useNativeTools);

        // Merge in any tool calls recovered from Ollama parse errors
        if (toolCalls.length === 0 && recoveredToolCalls.length > 0) {
          toolCalls = recoveredToolCalls;
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Using ${recoveredToolCalls.length} recovered tool call(s)`);
        }

        // Filter out any non-read-only tools that the model might try to call
        const allowedSet = mode === 'review' ? this.getSecurityReviewToolNames()
          : mode === 'deep-explore' ? DEEP_EXPLORE_TOOLS
          : READ_ONLY_TOOLS;
        const filteredToolCalls = toolCalls.filter(tc => allowedSet.has(tc.name));

        if (filteredToolCalls.length < toolCalls.length) {
          const blocked = toolCalls.filter(tc => !allowedSet.has(tc.name)).map(tc => tc.name);
          this.outputChannel.appendLine(`[${mode}] Blocked non-read-only tools: ${blocked.join(', ')}`);
        }

        if (filteredToolCalls.length === 0) {
          consecutiveNoToolIterations++;
          // Same thinking-in-history fix for no-tool path
          let noToolContent = response;
          if (thinkingContent && response.trim().length < 200) {
            const maxLen = 800;
            noToolContent = thinkingContent.length > maxLen
              ? '...' + thinkingContent.substring(thinkingContent.length - maxLen)
              : thinkingContent;
          }
          const noToolMsg: any = { role: 'assistant', content: noToolContent };
          if (thinkingContent) noToolMsg.thinking = thinkingContent;
          messages.push(noToolMsg);

          if (consecutiveNoToolIterations >= 2) break;

          if (iteration < maxIterations - 1) {
            const taskPreview = task.length > 200 ? task.substring(0, 200) + '…' : task;
            messages.push({
              role: 'user',
              content: `Reminder — your task: ${taskPreview}\nContinue exploring. Use tools to find more information or respond with [TASK_COMPLETE] if finished.`
            });
          }
          continue;
        }

        consecutiveNoToolIterations = 0;

        // --- Loop detection: check for repeated tool call patterns ---
        const currentSignatures = filteredToolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.args)}`);
        const duplicateCount = currentSignatures.filter(sig => prevToolSignatures.includes(sig)).length;
        const isDuplicate = prevToolSignatures.length > 0 && duplicateCount >= Math.ceil(currentSignatures.length * 0.5);

        if (isDuplicate) {
          consecutiveDuplicateIterations++;
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Duplicate tool calls detected (${duplicateCount}/${currentSignatures.length} repeated, streak: ${consecutiveDuplicateIterations})`);
          if (consecutiveDuplicateIterations >= 2) {
            this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Breaking: model is looping`);
            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: 'STOP. You are repeating the same tool calls from previous iterations. The results will not change. Synthesize what you have learned so far and respond with [TASK_COMPLETE].'
            });
            if (consecutiveDuplicateIterations >= 3) break;
            prevToolSignatures = currentSignatures;
            continue;
          }
        } else {
          consecutiveDuplicateIterations = 0;
        }
        prevToolSignatures = currentSignatures;

        // Execute read-only tools
        const toolNames = filteredToolCalls.map(tc => tc.name).join(', ');
        phase = `executing tools: ${toolNames}`;
        const groupTitle = getProgressGroupTitle(filteredToolCalls);
        emit({ type: 'startProgressGroup', title: groupTitle, sessionId });
        await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });

        // CRITICAL: With thinking models, the real reasoning lives in `thinking`
        // but it may not replay properly. When response is empty/minimal,
        // inject thinking into `content` so the model sees its own reasoning.
        let historyContent = response;
        if (thinkingContent && response.trim().length < 200) {
          const maxLen = 800;
          historyContent = thinkingContent.length > maxLen
            ? '...' + thinkingContent.substring(thinkingContent.length - maxLen)
            : thinkingContent;
        }
        const assistantMsg: any = { role: 'assistant', content: historyContent };
        if (thinkingContent) assistantMsg.thinking = thinkingContent;
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        // Persist assistant message with tool_calls metadata for multi-turn history.
        // Use historyContent (which includes thinking when response was empty).
        if (useNativeTools && nativeToolCalls.length > 0 && sessionId) {
          const serializedToolCalls = JSON.stringify(nativeToolCalls);
          await this.databaseService.addMessage(sessionId, 'assistant', historyContent || '', {
            model, toolCalls: serializedToolCalls
          });
        }

        const context = {
          workspace: primaryWorkspace,
          workspaceFolders: allFolders,
          token,
          outputChannel: this.outputChannel,
          sessionId
        };

        const toolResults: Array<{ role: 'tool'; content: string; tool_name: string }> = [];
        const xmlResults: string[] = [];

        // Split tools into local (parallelizable) vs Ollama-calling (sequential).
        // run_subagent spawns a sub-agent that makes its own Ollama API calls —
        // running multiple of those in parallel would overload the Ollama server.
        // All other explore tools are purely local (filesystem, ripgrep, LSP).
        const OLLAMA_CALLING_TOOLS = new Set(['run_subagent']);
        const localCalls: Array<{ toolCall: typeof filteredToolCalls[0]; idx: number }> = [];
        const sequentialCalls: Array<{ toolCall: typeof filteredToolCalls[0]; idx: number }> = [];
        const toolMeta = filteredToolCalls.map(tc => getToolActionInfo(tc.name, tc.args));

        for (let i = 0; i < filteredToolCalls.length; i++) {
          const bucket = OLLAMA_CALLING_TOOLS.has(filteredToolCalls[i].name) ? sequentialCalls : localCalls;
          bucket.push({ toolCall: filteredToolCalls[i], idx: i });
        }

        // Show all local tools as "running" at once
        for (const { idx } of localCalls) {
          const { actionText, actionDetail, actionIcon } = toolMeta[idx];
          emit({ type: 'showToolAction', status: 'running', icon: actionIcon, text: actionText, detail: actionDetail, sessionId });
        }

        // Helper: execute one tool and emit its result UI
        const executeSingle = async (toolCall: typeof filteredToolCalls[0], idx: number) => {
          const { actionText, actionIcon } = toolMeta[idx];

          // --- Tool result cache: return cached output for identical calls ---
          const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;
          if (CACHEABLE_TOOLS.has(toolCall.name)) {
            const cached = toolResultCache.get(cacheKey);
            if (cached) {
              const cacheNote = `[CACHED — You already called ${toolCall.name} with identical arguments in iteration ${cached.iteration}. The result has NOT changed. Do NOT call this again. Use different search terms, read specific files, or proceed with [TASK_COMPLETE].]`;
              const cachedOutput = cached.output + '\n\n' + cacheNote;
              const cachePayload = { status: 'success' as const, icon: actionIcon, text: `${actionText} (cached)`, detail: 'Identical call — returning cached result' };
              emit({ type: 'showToolAction', ...cachePayload, sessionId });
              await this.persistUiEvent(sessionId, 'showToolAction', cachePayload);
              return { toolCall, idx, output: cachedOutput, error: undefined as string | undefined };
            }
          }

          try {
            const result = await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            const output = result.output || '';

            // Cache the result for future identical calls
            if (CACHEABLE_TOOLS.has(toolCall.name)) {
              toolResultCache.set(cacheKey, { output, iteration });
            }

            const { actionText: successText, actionDetail: successDetail, filePath: successFilePath, startLine: successStartLine } =
              getToolSuccessInfo(toolCall.name, toolCall.args, output);
            const successPayload: any = {
              status: 'success' as const, icon: actionIcon, text: successText, detail: successDetail,
              ...(successFilePath ? { filePath: successFilePath } : {}),
              ...(successStartLine != null ? { startLine: successStartLine } : {})
            };
            emit({ type: 'showToolAction', ...successPayload, sessionId });
            await this.persistUiEvent(sessionId, 'showToolAction', successPayload);
            return { toolCall, idx, output, error: undefined as string | undefined };
          } catch (error: any) {
            const errorPayload = { status: 'error' as const, icon: actionIcon, text: actionText, detail: error.message };
            emit({ type: 'showToolAction', ...errorPayload, sessionId });
            await this.persistUiEvent(sessionId, 'showToolAction', errorPayload);
            return { toolCall, idx, output: '', error: error.message as string | undefined };
          }
        };

        // Execute local tools in parallel (filesystem, ripgrep, LSP — no Ollama calls)
        const localResults = await Promise.all(
          localCalls.map(({ toolCall, idx }) => executeSingle(toolCall, idx))
        );

        // Execute Ollama-calling tools sequentially (run_subagent)
        const seqResults: typeof localResults = [];
        for (const { toolCall, idx } of sequentialCalls) {
          if (token.isCancellationRequested) break;
          const { actionText, actionDetail, actionIcon } = toolMeta[idx];
          emit({ type: 'showToolAction', status: 'running', icon: actionIcon, text: actionText, detail: actionDetail, sessionId });
          seqResults.push(await executeSingle(toolCall, idx));
        }

        // Merge results in original tool call order for conversation history
        const allResults = [...localResults, ...seqResults].sort((a, b) => a.idx - b.idx);
        for (const { toolCall, output, error: errMsg } of allResults) {
          // Track for "tools already called" summary in continuation messages
          const argSummary = toolCall.name === 'search_workspace'
            ? `"${toolCall.args.query || ''}"` : toolCall.name === 'read_file'
            ? `${toolCall.args.path || toolCall.args.file || ''}` : JSON.stringify(toolCall.args).substring(0, 60);
          const resultLine = errMsg ? 'ERROR' : output.split('\n')[0].substring(0, 80);
          toolCallHistory.push({ name: toolCall.name, query: argSummary, resultSummary: resultLine });

          if (errMsg) {
            if (useNativeTools) {
              toolResults.push({ role: 'tool', content: `Error: ${errMsg}`, tool_name: toolCall.name });
            } else {
              xmlResults.push(`Tool ${toolCall.name} failed: ${errMsg}`);
            }
          } else {
            if (sessionId) {
              await this.databaseService.addMessage(sessionId, 'tool', output, {
                model, toolName: toolCall.name,
                toolInput: JSON.stringify(toolCall.args),
                toolOutput: output,
                progressTitle: groupTitle
              });
            }
            if (useNativeTools) {
              toolResults.push({ role: 'tool', content: output, tool_name: toolCall.name });
            } else {
              xmlResults.push(`Tool result for ${toolCall.name}:\n${output}`);
            }
          }
        }

        emit({ type: 'finishProgressGroup', sessionId });
        await this.persistUiEvent(sessionId, 'finishProgressGroup', {});

        // Feed results back
        if (useNativeTools) {
          messages.push(...toolResults);

          // Build "tools already called" summary so the model knows what it did
          const historyLines = toolCallHistory.map(h => `  - ${h.name}(${h.query}) → ${h.resultSummary}`);
          const historyBlock = historyLines.length > 0
            ? `\nTools already called this session (do NOT repeat these):\n${historyLines.join('\n')}`
            : '';

          const taskPreview = task.length > 200 ? task.substring(0, 200) + '…' : task;
          messages.push({
            role: 'user',
            content: `Reminder — your task: ${taskPreview}\nDo NOT repeat your plan. Proceed directly with tool calls or [TASK_COMPLETE].\nWhen searching for multiple symbols, use ONE search_workspace call with regex: query="symbolA|symbolB|symbolC" isRegex=true${historyBlock}`
          });
        } else if (xmlResults.length > 0) {
          const historyLines = toolCallHistory.map(h => `  - ${h.name}(${h.query}) → ${h.resultSummary}`);
          const historyBlock = historyLines.length > 0
            ? `\nTools already called this session (do NOT repeat these):\n${historyLines.join('\n')}`
            : '';

          messages.push({
            role: 'user',
            content: xmlResults.join('\n\n') + `\n\nDo NOT repeat your plan. Proceed directly with tool calls or [TASK_COMPLETE].\nWhen searching for multiple symbols, use ONE search_workspace call with regex: query="symbolA|symbolB|symbolC" isRegex=true${historyBlock}`
          });
        }

        // Course-correct if repetitive text was detected this iteration.
        // The corrective message goes AFTER tool results so the model sees
        // fresh data AND the instruction to stop restating its plan.
        if (repetitionCorrectionNeeded) {
          messages.push({
            role: 'user',
            content: 'STOP. You are repeating yourself — your last response was nearly identical to the previous one. Do NOT restate your plan or analysis. Proceed DIRECTLY with the next tool call, or output [TASK_COMPLETE] if done.'
          });
        }
      } catch (error: any) {
        const errMsg = error.message || String(error);
        const errorClass = error.name && error.name !== 'Error' ? `[${error.name}] ` : '';
        const statusInfo = error.statusCode ? ` (HTTP ${error.statusCode})` : '';
        this.outputChannel.appendLine(`[AgentExploreExecutor] Fatal error at iteration ${iteration}/${maxIterations} (phase: ${phase}): ${errorClass}${errMsg}${statusInfo}`);
        const displayError = `${errorClass}${errMsg}${statusInfo}\n_(model: ${model}, mode: ${mode}, phase: ${phase}, iteration ${iteration}/${maxIterations})_`;
        await this.persistUiEvent(sessionId, 'showError', { message: displayError });
        emit({ type: 'showError', message: displayError, sessionId });
        break;
      }
    }

    // Build final result
    const summary = accumulatedExplanation || 'Exploration completed.';

    // Sub-agents: return summary to caller without posting finalMessage or
    // persisting an assistant message (the parent agent handles user-facing output).
    let assistantMessage: MessageRecord;
    if (isSubagent) {
      assistantMessage = {
        id: `msg_${Date.now()}`,
        session_id: sessionId,
        role: 'assistant' as const,
        content: summary,
        model,
        created_at: new Date().toISOString(),
        timestamp: Date.now()
      } as MessageRecord;
    } else {
      assistantMessage = hasPersistedIterationText
        ? {
            id: `msg_${Date.now()}`,
            session_id: sessionId,
            role: 'assistant' as const,
            content: summary,
            model,
            created_at: new Date().toISOString(),
            timestamp: Date.now()
          } as MessageRecord
        : await this.databaseService.addMessage(sessionId, 'assistant', summary, { model });

      const finalContent = summary.replace(/\[TASK_COMPLETE\]/gi, '').trim();
      if (finalContent) {
        emit({ type: 'finalMessage', content: finalContent, model, sessionId });
      }
      emit({ type: 'hideThinking', sessionId });
    }

    const cleanedSummary = summary.replace(/\[TASK_COMPLETE\]/gi, '').trim();
    return { summary: cleanedSummary, assistantMessage };
  }

  /**
   * Run a sub-agent exploration (called by `run_subagent` tool).
   * Same loop as `execute()` but in sub-agent mode: text streaming and
   * thinking/final message emissions are suppressed. Only tool UI (progress
   * groups, tool actions) passes through to the webview.
   *
   * Follows Claude Code's pattern: "The result returned by the agent is not
   * visible to the user." The accumulated exploration text is returned to
   * the parent agent as tool output — the parent decides what to show.
   */
  async executeSubagent(
    task: string,
    token: vscode.CancellationToken,
    sessionId: string,
    model: string,
    mode: 'explore' | 'review' | 'deep-explore',
    capabilities?: ModelCapabilities
  ): Promise<string> {
    const modeCaps: Record<string, number> = { review: 15, 'deep-explore': 20, explore: 10 };
    const config: ExecutorConfig = {
      maxIterations: Math.min(getConfig().agent.maxIterations, modeCaps[mode] || 10),
      toolTimeout: getConfig().agent.toolTimeout,
      temperature: 0.5
    };

    // Execute in sub-agent mode (isSubagent = true) — suppresses text streaming,
    // thinking, finalMessage, iterationBoundary, and DB assistant message persistence.
    const result = await this.execute(task, config, token, sessionId, model, mode, capabilities, undefined, /* isSubagent */ true);
    return result.summary || 'Sub-agent completed with no findings.';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildSystemPrompt(mode: ExploreMode, folders: readonly vscode.WorkspaceFolder[], primary?: vscode.WorkspaceFolder, useNativeTools?: boolean): string {
    switch (mode) {
      case 'plan':
        return this.promptBuilder.buildPlanPrompt(folders, primary, useNativeTools);
      case 'review':
        return this.promptBuilder.buildSecurityReviewPrompt(folders, primary, useNativeTools);
      case 'deep-explore':
        return this.promptBuilder.buildDeepExplorePrompt(folders, primary, useNativeTools);
      case 'chat':
        return this.promptBuilder.buildChatPrompt(folders, primary, useNativeTools);
      default:
        return this.promptBuilder.buildExplorePrompt(folders, primary, useNativeTools);
    }
  }

  private getToolDefinitions(mode: ExploreMode): any[] {
    if (mode === 'review') {
      return this.promptBuilder.getSecurityReviewToolDefinitions();
    }
    if (mode === 'deep-explore') {
      return this.promptBuilder.getDeepExploreToolDefinitions();
    }
    return this.promptBuilder.getReadOnlyToolDefinitions();
  }

  private getSecurityReviewToolNames(): Set<string> {
    return new Set([...READ_ONLY_TOOLS, 'run_terminal_command']);
  }

  /**
   * Recover a tool call from an Ollama tool-parse error message.
   * See agentChatExecutor.recoverToolCallFromError for full docs.
   */
  private recoverToolCallFromError(
    errText: string,
    nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>,
    mode: string,
    iteration: number
  ): { name: string; args: any } | null {
    const rawMatch = errText.match(/raw='(\{[\s\S]*?\})'/) || errText.match(/raw='(\{[\s\S]*?)' *err=/) || errText.match(/raw='(\{[\s\S]*\})/);
    if (!rawMatch) {
      this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Recovery: no raw JSON found in error text`);
      return null;
    }
    const fixed = rawMatch[1].replace(/[\u201C\u201D\u201E\u201F\u2018\u2019\u201A\u201B\uFF02\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F\uFE41\uFE42\uFE43\uFE44]/g, '"');
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
        this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Recovered tool call: ${name}(${JSON.stringify(args)})`);
        return { name, args };
      }
      this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Recovery: could not determine tool name`);
      return null;
    } catch (e) {
      this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Recovery JSON parse failed: ${e}`);
      return null;
    }
  }

  private parseToolCalls(
    response: string,
    nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>,
    useNativeTools: boolean
  ): Array<{ name: string; args: any }> {
    if (useNativeTools && nativeToolCalls.length > 0) {
      return nativeToolCalls.map(tc => ({
        name: tc.function?.name || '',
        args: tc.function?.arguments || {}
      }));
    }
    return extractToolCalls(response);
  }

  private async persistUiEvent(
    sessionId: string | undefined,
    eventType: string,
    payload: Record<string, any>
  ): Promise<void> {
    if (!sessionId) return;
    try {
      await this.databaseService.addMessage(sessionId, 'tool', '', {
        toolName: '__ui__',
        toolOutput: JSON.stringify({ eventType, payload })
      });
    } catch (error) {
      console.warn('[persistUiEvent] Failed to persist UI event:', error);
    }
  }
}
