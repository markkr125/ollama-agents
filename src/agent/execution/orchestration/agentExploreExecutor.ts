import * as vscode from 'vscode';
import { getConfig } from '../../../config/settings';
import { DatabaseService } from '../../../services/database/databaseService';
import { extractContextLength, ModelCapabilities } from '../../../services/model/modelCompatibility';
import { OllamaClient } from '../../../services/model/ollamaClient';
import { ExecutorConfig } from '../../../types/agent';
import { ChatRequest } from '../../../types/ollama';
import { MessageRecord } from '../../../types/session';
import { extractToolCalls, removeToolCalls } from '../../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../../../views/toolUIFormatter';
import { ToolRegistry } from '../../toolRegistry';
import { AgentPromptBuilder } from '../prompts/agentPromptBuilder';
import { AgentContextCompactor, estimateTokensByCategory } from '../streaming/agentContextCompactor';
import { buildToolCallSummary, checkNoToolCompletion, computeDynamicNumCtx } from '../streaming/agentControlPlane';
import { AgentStreamProcessor } from '../streaming/agentStreamProcessor';

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

// Analyze-with-write: deep exploration + write_file for documentation/report output
const ANALYZE_WRITE_TOOLS = new Set([...DEEP_EXPLORE_TOOLS, 'write_file']);

// ---------------------------------------------------------------------------
// AgentExploreExecutor — read-only exploration agent. Same streaming loop
// as AgentChatExecutor but restricted to read-only tools. No checkpoints,
// no approval flow, no file writes.
// ---------------------------------------------------------------------------

export type ExploreMode = 'explore' | 'plan' | 'review' | 'deep-explore' | 'deep-explore-write' | 'chat';

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
    primaryWorkspaceHint?: vscode.WorkspaceFolder,
    subagentTitle?: string,
    subagentContextHint?: string,
    subagentDescription?: string
  ): Promise<ExploreResult> {
    const allFolders = vscode.workspace.workspaceFolders || [];
    const primaryWorkspace = primaryWorkspaceHint || allFolders[0];
    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();

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

    // Sub-agent mode: suppress text streaming, thinking, final message, AND
    // per-iteration progress group events. The sub-agent gets ONE wrapper
    // progress group (emitted before/after the loop) containing all tool
    // actions and thinking. Internal startProgressGroup/finishProgressGroup
    // are suppressed so actions funnel into the wrapper group.
    const subLabel = subagentTitle ? `Sub-agent: ${subagentTitle}` : 'Sub-agent';
    const emit = isSubagent
      ? (msg: any) => {
          const TOOL_UI_TYPES = new Set([
            'showToolAction',
            'showError', 'showWarningBanner', 'subagentThinking',
          ]);
          if (TOOL_UI_TYPES.has(msg.type)) {
            this.emitter.postMessage(msg);
          }
        }
      : (msg: any) => this.emitter.postMessage(msg);
    const silentEmitter: WebviewMessageEmitter = { postMessage: emit };
    const activeStreamProcessor = isSubagent
      ? new AgentStreamProcessor(this.client, silentEmitter)
      : this.streamProcessor;

    // Build mode-specific system prompt
    await this.promptBuilder.loadProjectContext(primaryWorkspace);
    const systemContent = this.buildSystemPrompt(mode, allFolders, primaryWorkspace, useNativeTools, isSubagent, subagentContextHint);

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

    // Sub-agent wrapper group: single group containing all sub-agent actions
    if (isSubagent) {
      await this.persistUiEvent(sessionId, 'startProgressGroup', { title: subLabel, isSubagent: true });
      this.emitter.postMessage({ type: 'startProgressGroup', title: subLabel, isSubagent: true, sessionId });

      // Emit description as the first action inside the group so it isn't empty
      // while the sub-agent is starting up. Transitions to ✓ when group finishes.
      if (subagentDescription) {
        const descPayload = { status: 'running', icon: '📋', text: subagentDescription };
        await this.persistUiEvent(sessionId, 'showToolAction', descPayload);
        emit({ type: 'showToolAction', ...descPayload, sessionId });
      }
    }

    // Per-mode iteration caps (lower than agent mode)
    const modeCaps: Record<string, number> = { review: 15, 'deep-explore': 20, 'deep-explore-write': 20, plan: 10, chat: 10, explore: 10 };
    const maxIterations = Math.min(config.maxIterations, modeCaps[mode] || 10);
    let iteration = 0;
    let accumulatedExplanation = '';
    let accumulatedSubagentThinking = '';
    let hasPersistedIterationText = false;
    let consecutiveNoToolIterations = 0;
    let lastPromptTokens: number | undefined;

    while (iteration < maxIterations && !token.isCancellationRequested) {
      iteration++;

      // Diagnostic: log conversation state at each iteration start
      const totalContentChars = messages.reduce((sum: number, m: any) => sum + (m.content?.length || 0), 0);
      const roleCounts = messages.reduce((acc: Record<string, number>, m: any) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
      }, {});
      const roleBreakdown = Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(', ');
      this.outputChannel.appendLine(`[Explore Iteration ${iteration}] Messages: ${messages.length} (${roleBreakdown}) — ~${Math.round(totalContentChars / 4)} est. tokens`);

      // DIAGNOSTIC: Dump full messages array structure so we can verify
      // tool results are actually being accumulated across iterations
      for (let mi = 0; mi < messages.length; mi++) {
        const m = messages[mi];
        const contentPreview = (m.content || '').substring(0, 120).replace(/\n/g, '\\n');
        const toolCallsInfo = m.tool_calls ? ` tool_calls:[${m.tool_calls.length}]` : '';
        const toolNameInfo = m.tool_name ? ` tool_name:${m.tool_name}` : '';
        this.outputChannel.appendLine(`  [msg ${mi}] role=${m.role}${toolNameInfo}${toolCallsInfo} content(${(m.content || '').length})="${contentPreview}"`);
      }

      let phase = 'preparing request';

      try {
        // Context compaction for long explorations
        // contextWindow: the model's EFFECTIVE context limit — used for compaction decisions.
        // numCtx: the DYNAMIC value sent to Ollama — sized to the actual payload.
        const detectedContextWindow = capabilities?.contextLength;
        const userContextWindow = getConfig().contextWindow || 16000;
        const rawContextWindow = detectedContextWindow || userContextWindow;
        // Two-tier cap: per-model override → global setting (default 64K)
        const globalCap = getConfig().agent.maxContextWindow;
        const effectiveCap = capabilities?.maxContext ?? globalCap;
        const contextWindow = Math.min(rawContextWindow, effectiveCap);
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

        // DEFENSIVE: Strip thinking from ALL history messages before sending.
        // Per Ollama #10448 / Qwen3 docs: "No Thinking Content in History".
        for (const msg of messages) {
          if ('thinking' in msg) {
            delete (msg as any).thinking;
          }
        }

        // Build chat request — pick the mode-specific config for temperature/maxTokens
        const modeConfigMap: Record<string, 'chatMode' | 'planMode' | 'agentMode'> = {
          chat: 'chatMode', plan: 'planMode', explore: 'agentMode',
          'deep-explore': 'agentMode', review: 'agentMode',
        };
        const modeConfig = getConfig()[modeConfigMap[mode] || 'agentMode'];

        // Estimate payload tokens for dynamic num_ctx sizing
        const payloadChars = messages.reduce((s: number, m: any) => s + (m.content?.length || 0), 0);
        const toolDefsForMode = useNativeTools ? this.getToolDefinitions(mode) : undefined;
        const toolDefCharsForCtx = toolDefsForMode ? JSON.stringify(toolDefsForMode).length : 0;
        const payloadEstTokens = Math.round((payloadChars + toolDefCharsForCtx) / 4);
        const numCtx = computeDynamicNumCtx(payloadEstTokens, modeConfig.maxTokens, contextWindow);

        const chatRequest: ChatRequest = {
          model,
          messages,
          ...(agentConfig.keepAlive ? { keep_alive: agentConfig.keepAlive } : {}),
          options: {
            temperature: modeConfig.temperature,
            num_predict: modeConfig.maxTokens,
            num_ctx: numCtx,
            stop: ['[TASK_COMPLETE]'],
          },
        };
        if (useNativeTools) {
          chatRequest.tools = toolDefsForMode;
        }

        // --- Diagnostic: log request payload sizes for debugging slow models ---
        {
          const sysMsg = messages[0]?.role === 'system' ? messages[0].content : '';
          const sysChars = sysMsg.length;
          const sysEstTokens = Math.round(sysChars / 4);
          const toolDefCount = chatRequest.tools?.length || 0;
          const toolDefChars = chatRequest.tools ? JSON.stringify(chatRequest.tools).length : 0;
          const toolDefEstTokens = Math.round(toolDefChars / 4);
          const totalChars = messages.reduce((s: number, m: any) => s + (m.content?.length || 0), 0);
          const totalEstTokens = Math.round(totalChars / 4);
          this.outputChannel.appendLine(
            `[${mode}][Iteration ${iteration}] Request payload: system_prompt=${sysEstTokens}tok(${sysChars}ch), ` +
            `tool_defs=${toolDefEstTokens}tok(${toolDefChars}ch, ${toolDefCount} tools), ` +
            `total_messages=${totalEstTokens}tok(${totalChars}ch), ` +
            `num_ctx=${numCtx} (dynamic, model_max=${contextWindow}), num_predict=${modeConfig.maxTokens}, temp=${modeConfig.temperature}`
          );
          // On first iteration, dump the full system prompt so users can review it
          if (iteration === 1) {
            this.outputChannel.appendLine(`[${mode}][Iteration 1] === SYSTEM PROMPT START ===`);
            this.outputChannel.appendLine(sysMsg);
            this.outputChannel.appendLine(`[${mode}][Iteration 1] === SYSTEM PROMPT END (${sysChars} chars, ~${sysEstTokens} tokens) ===`);
          }
        }

        if (iteration > 1) {
          emit({ type: 'iterationBoundary', sessionId });
        }

        phase = 'streaming response from model';
        const thinkingStartTime = Date.now();
        const streamResult = await activeStreamProcessor.streamIteration(
            chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime,
            useNativeTools ? undefined : this.toolRegistry.getToolNames()
          );

        let { response } = streamResult;
        const { thinkingContent, nativeToolCalls, toolParseErrors } = streamResult;

        // --- Recover from Ollama tool-parse errors (smart/curly quotes) ---
        // Must happen BEFORE text processing — otherwise the error text leaks
        // into the UI as regular assistant chat text.
        const recoveredToolCalls: Array<{ name: string; args: any }> = [];
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
          // Truncation detection: compare what we sent vs what the model actually processed
          const sentChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
          const sentEstTokens = Math.round(sentChars / 4);
          const sentMsgCount = messages.length;
          const actualPrompt = streamResult.promptTokens;
          const ratio = sentEstTokens > 0 ? (actualPrompt / sentEstTokens) : 1;
          let truncationWarning = '';
          if (ratio < 0.5 && sentEstTokens > 1000) {
            truncationWarning = ` ⚠️ POSSIBLE TRUNCATION: sent ~${sentEstTokens} est. tokens (${sentMsgCount} msgs, ${sentChars} chars) but model only processed ${actualPrompt} prompt tokens (ratio=${ratio.toFixed(2)}). The server may be silently dropping messages!`;
          }
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Token usage: prompt=${actualPrompt}, completion=${streamResult.completionTokens ?? '?'}, context_window=${contextWindow}, sent_est=${sentEstTokens}, sent_msgs=${sentMsgCount}, ratio=${ratio.toFixed(2)}${truncationWarning}`);
        }

        // Emit token usage to the webview for the live indicator
        if (!isSubagent) {
          const toolDefCount = useNativeTools ? this.getToolDefinitions(mode).length : 0;
          const categories = estimateTokensByCategory(messages, toolDefCount, lastPromptTokens);
          const tokenPayload = {
            promptTokens: lastPromptTokens ?? categories.total,
            completionTokens: streamResult.completionTokens,
            contextWindow,
            categories
          };
          emit({
            type: 'tokenUsage',
            sessionId,
            ...tokenPayload
          });
          // Persist to DB so session history shows the last token usage state
          await this.persistUiEvent(sessionId, 'tokenUsage', tokenPayload);
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

          }
        } else {
          // Sub-agent thinking: emit as subagentThinking so the parent's
          // webview can show it inside the sub-agent's progress group.
          const displayThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
          if (displayThinking) {
            // Accumulate thinking so we can return it to the parent if the
            // model never produces text output (common with thinking models).
            if (accumulatedSubagentThinking) accumulatedSubagentThinking += '\n\n';
            accumulatedSubagentThinking += displayThinking;

            const thinkingEndTime = streamResult.lastThinkingTimestamp || Date.now();
            const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
            const thinkingPayload = { content: displayThinking, durationSeconds };
            await this.persistUiEvent(sessionId, 'subagentThinking', thinkingPayload);
            emit({ type: 'subagentThinking', ...thinkingPayload, sessionId });
          }
        }

        // Process text
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();

        if (iterationDelta) {
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

        // Check for completion — also check thinkingContent for thinking models
        const completionSignal = (response + ' ' + thinkingContent).toLowerCase();
        if (completionSignal.includes('[task_complete]') || completionSignal.includes('task is complete') || completionSignal.includes('[end_of_exploration]')) {
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
          : mode === 'deep-explore-write' ? ANALYZE_WRITE_TOOLS
          : mode === 'deep-explore' ? DEEP_EXPLORE_TOOLS
          : READ_ONLY_TOOLS;
        let filteredToolCalls = toolCalls.filter(tc => allowedSet.has(tc.name));

        if (filteredToolCalls.length < toolCalls.length) {
          const blocked = toolCalls.filter(tc => !allowedSet.has(tc.name)).map(tc => tc.name);
          this.outputChannel.appendLine(`[${mode}] Blocked non-read-only tools: ${blocked.join(', ')}`);
        }

        if (filteredToolCalls.length === 0) {
          consecutiveNoToolIterations++;
          // NO THINKING IN HISTORY: Per Ollama issue #10448 and Qwen3 docs.
          // Use response content or '[Reasoning completed]' marker to prevent
          // blank-turn amnesia without re-injecting thinking content.
          const noToolMsg: any = { role: 'assistant', content: response || (thinkingContent ? '[Reasoning completed]' : '') };
          messages.push(noToolMsg);

          // Smart completion detection (pure function — see agentControlPlane.ts).
          // Explore executor doesn't track hasWrittenFiles directly — for
          // deep-explore-write mode, an empty response is still a strong
          // done signal, so we pass hasWrittenFiles=true to trigger
          // break_implicit on truly empty responses in all modes.
          const completionAction = checkNoToolCompletion({
            response, thinkingContent, hasWrittenFiles: true, consecutiveNoToolIterations
          });

          if (completionAction !== 'continue') {
            this.outputChannel.appendLine(`[${mode}] Breaking: ${completionAction}`);
            break;
          }

          if (iteration < maxIterations - 1) {
            messages.push({
              role: 'user',
              content: 'If you are done, respond with [TASK_COMPLETE]. Otherwise, continue using tools.'
            });
          }
          continue;
        }

        consecutiveNoToolIterations = 0;

        // Over-eager mitigation: truncate excessive tool batches
        const TOOL_COUNT_HARD = 15;
        if (filteredToolCalls.length > TOOL_COUNT_HARD) {
          const dropped = filteredToolCalls.length - TOOL_COUNT_HARD;
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Over-eager: truncated ${filteredToolCalls.length} tools to ${TOOL_COUNT_HARD} (dropped ${dropped})`);
          filteredToolCalls = filteredToolCalls.slice(0, TOOL_COUNT_HARD);
        }

        // Execute read-only tools
        const toolNames = filteredToolCalls.map(tc => tc.name).join(', ');
        phase = `executing tools: ${toolNames}`;
        const groupTitle = getProgressGroupTitle(filteredToolCalls);
        // Sub-agents: skip internal per-iteration groups — actions go into the wrapper group
        if (!isSubagent) {
          emit({ type: 'startProgressGroup', title: groupTitle, sessionId });
          await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });
        }

        // NO thinking field in history — see Ollama issue #10448.
        // CRITICAL: Prefer the compact tool summary over the model's verbose
        // planning text. The response was already streamed to the UI, but
        // keeping it in history causes the model to see its own plan and
        // restate it every iteration (see Pitfall #38).
        const toolSummary = buildToolCallSummary(filteredToolCalls);
        const assistantContent = toolSummary || response || (thinkingContent ? '[Reasoning completed]' : '');
        const assistantMsg: any = { role: 'assistant', content: assistantContent };
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        // Persist assistant message with tool_calls metadata for multi-turn history.
        // IMPORTANT: Persist original `response`, NOT `historyContent`.
        // Thinking is already persisted as a separate `thinkingBlock` UI event.
        // iterationDelta (clean text) is already persisted above.
        if (useNativeTools && nativeToolCalls.length > 0 && sessionId) {
          const serializedToolCalls = JSON.stringify(nativeToolCalls);
          const persistContent = hasPersistedIterationText ? '' : (response.trim() || '');
          await this.databaseService.addMessage(sessionId, 'assistant', persistContent, {
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

          try {
            const result = await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            // ToolRegistry catches errors internally and returns { output: '', error: msg }
            // instead of throwing. Re-throw so our catch block handles it properly.
            if (result.error) {
              throw new Error(result.error);
            }
            const output = result.output || '';

            const { actionText: successText, actionDetail: successDetail, filePath: successFilePath, startLine: successStartLine } =
              getToolSuccessInfo(toolCall.name, toolCall.args, output);
            const successPayload: any = {
              status: 'success' as const, icon: actionIcon, text: successText, detail: successDetail,
              ...(successFilePath ? { filePath: successFilePath } : {}),
              ...(successStartLine != null ? { startLine: successStartLine } : {})
            };
            // Sub-agent creates its own wrapper progress group — skip redundant success action
            if (toolCall.name !== 'run_subagent') {
              emit({ type: 'showToolAction', ...successPayload, sessionId });
            }
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
          // Sub-agent creates its own wrapper progress group — skip redundant running action
          if (toolCall.name !== 'run_subagent') {
            emit({ type: 'showToolAction', status: 'running', icon: actionIcon, text: actionText, detail: actionDetail, sessionId });
          }
          seqResults.push(await executeSingle(toolCall, idx));
        }

        // Merge results in original tool call order for conversation history
        const allResults = [...localResults, ...seqResults].sort((a, b) => a.idx - b.idx);
        for (const { toolCall, output, error: errMsg } of allResults) {
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

        // Sub-agents: skip internal per-iteration group close
        if (!isSubagent) {
          emit({ type: 'finishProgressGroup', sessionId });
          await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
        }

        // Feed results back. NO task reminder — the full task is in messages[1].
        // Adding a truncated preview caused models to fixate on the incomplete
        // snippet instead of referencing the original user message.
        if (useNativeTools) {
          messages.push(...toolResults);

          messages.push({
            role: 'user',
            content: `Proceed with tool calls or [TASK_COMPLETE].`
          });
        } else if (xmlResults.length > 0) {
          messages.push({
            role: 'user',
            content: xmlResults.join('\n\n') + `\n\nProceed with tool calls or [TASK_COMPLETE].`
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

    // Close sub-agent wrapper group
    if (isSubagent) {
      await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
      this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
    }

    // Build final result — for sub-agents, fall back to thinking content
    // (thinking models put analysis in thinking field, not response) and
    // then to a tool results summary so the parent gets useful data.
    let summary: string;
    if (accumulatedExplanation) {
      summary = accumulatedExplanation;
    } else if (isSubagent && accumulatedSubagentThinking) {
      // Thinking models: analysis is in thinking field. Cap at 4K chars
      // to prevent token flooding in the parent's context.
      const maxChars = 4000;
      summary = accumulatedSubagentThinking.length > maxChars
        ? accumulatedSubagentThinking.substring(0, maxChars) + `\n\n[Thinking truncated — ${accumulatedSubagentThinking.length} chars total]`
        : accumulatedSubagentThinking;
    } else if (isSubagent) {
      // No text and no thinking — build summary from tool results
      summary = this.buildToolResultsSummary(messages);
    } else {
      summary = 'Exploration completed.';
    }

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

      // Only send finalMessage with content that wasn't already streamed.
      // When hasPersistedIterationText is true, the explanation was already
      // shown in the webview via streamChunk — sending it again in
      // finalMessage would duplicate the text (handleFinalMessage appends).
      if (!hasPersistedIterationText) {
        const finalContent = summary.replace(/\[TASK_COMPLETE\]/gi, '').trim();
        if (finalContent) {
          emit({ type: 'finalMessage', content: finalContent, model, sessionId });
        }
      } else {
        // Text already streamed — just signal generation end via empty finalMessage.
        // This resets currentStreamIndex in the webview so the next user
        // message starts a fresh assistant thread (Critical Rule #3).
        emit({ type: 'finalMessage', content: '', model, sessionId });
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
    capabilities?: ModelCapabilities,
    contextHint?: string,
    title?: string,
    primaryWorkspaceHint?: vscode.WorkspaceFolder,
    description?: string
  ): Promise<string> {
    const modeCaps: Record<string, number> = { review: 15, 'deep-explore': 20, explore: 10 };
    const config: ExecutorConfig = {
      maxIterations: Math.min(getConfig().agent.maxIterations, modeCaps[mode] || 10),
      toolTimeout: getConfig().agent.toolTimeout,
      temperature: 0.5
    };

    // Execute in sub-agent mode (isSubagent = true) — suppresses text streaming,
    // thinking, finalMessage, iterationBoundary, and DB assistant message persistence.
    // The title is used to prefix sub-agent progress groups in the UI.
    // contextHint is injected into the system prompt for focused exploration.
    const result = await this.execute(task, config, token, sessionId, model, mode, capabilities, undefined, /* isSubagent */ true, primaryWorkspaceHint, title, contextHint, description);
    return result.summary || 'Sub-agent completed with no findings.';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a brief summary from tool results in the conversation messages.
   * Used as a last resort when the sub-agent produces no text or thinking
   * output (e.g., non-thinking models that output only tool calls).
   */
  private buildToolResultsSummary(messages: any[]): string {
    const toolEntries: string[] = [];
    for (const m of messages) {
      if (m.role !== 'tool' || !m.tool_name || m.tool_name === '__ui__') continue;
      const content = (m.content || '').trim();
      if (!content) continue;

      const name = m.tool_name;
      // Extract a one-line summary from the tool output
      const firstLine = content.split('\n')[0].substring(0, 120);
      toolEntries.push(`- ${name}: ${firstLine}`);

      // Include the full output for read_file (truncated) since it's the
      // most valuable for the parent agent
      if (name === 'read_file' && content.length > 150) {
        toolEntries[toolEntries.length - 1] += ` (${content.length} chars)`;
      }
    }
    if (toolEntries.length === 0) return 'Exploration completed.';
    // Cap at 3K chars to keep parent context manageable
    const joined = `Tool results summary:\n${toolEntries.join('\n')}`;
    return joined.length > 3000
      ? joined.substring(0, 3000) + '\n[Summary truncated]'
      : joined;
  }

  private buildSystemPrompt(
    mode: ExploreMode,
    folders: readonly vscode.WorkspaceFolder[],
    primary?: vscode.WorkspaceFolder,
    useNativeTools?: boolean,
    isSubagent?: boolean,
    contextHint?: string
  ): string {
    // Sub-agents get a compact, focused prompt to save context budget
    if (isSubagent) {
      return this.promptBuilder.buildSubAgentExplorePrompt(folders, primary, useNativeTools, contextHint);
    }
    switch (mode) {
      case 'plan':
        return this.promptBuilder.buildPlanPrompt(folders, primary, useNativeTools);
      case 'review':
        return this.promptBuilder.buildSecurityReviewPrompt(folders, primary, useNativeTools);
      case 'deep-explore-write':
        return this.promptBuilder.buildAnalyzeWithWritePrompt(folders, primary, useNativeTools);
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
    if (mode === 'deep-explore-write') {
      return this.promptBuilder.getAnalyzeWithWriteToolDefinitions();
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
