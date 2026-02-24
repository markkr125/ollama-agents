import * as vscode from 'vscode';
import { getConfig } from '../../../config/settings';
import { DatabaseService } from '../../../services/database/databaseService';
import { ModelCapabilities } from '../../../services/model/modelCompatibility';
import { OllamaClient } from '../../../services/model/ollamaClient';
import { ExecutorConfig } from '../../../types/agent';
import { MessageRecord } from '../../../types/session';
import { removeToolCalls } from '../../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../../../views/toolUIFormatter';
import { ToolRegistry } from '../../toolRegistry';
import { AgentEventEmitter, FilteredAgentEventEmitter, SUB_AGENT_ALLOWED_TYPES } from '../agentEventEmitter';
import {
    buildAndEmitFatalError,
    buildAndPersistAssistantToolMessage,
    buildChatRequest,
    compactAndEmit,
    computeEffectiveContextWindow,
    deduplicateThinkingEcho,
    emitTokenUsage,
    logIterationState, logRequestPayload,
    parseToolCalls,
    persistCancellationThinking, persistThinkingBlock,
    recoverToolCallFromError,
    resolveContextWindow,
    trackPromptTokens
} from '../agentLoopHelpers';
import { ConversationHistory } from '../conversationHistory';
import { AgentPromptBuilder } from '../prompts/agentPromptBuilder';
import { AgentContextCompactor } from '../streaming/agentContextCompactor';
import { buildToolCallSummary, checkNoToolCompletion } from '../streaming/agentControlPlane';
import { AgentStreamProcessor } from '../streaming/agentStreamProcessor';

// ---------------------------------------------------------------------------
// Read-only tool names — only these tools are allowed in explore/plan modes.
// ---------------------------------------------------------------------------

import { getToolsForMode } from '../toolSets';

// ---------------------------------------------------------------------------
// Standalone helper — exported for testability
// ---------------------------------------------------------------------------

/**
 * Build a summary from tool results in conversation messages.
 * Used as a fallback when a sub-agent produces no text or thinking
 * output (e.g., non-thinking models that output only tool calls).
 *
 * For read_file, search_workspace, and LSP tool results, includes the
 * FULL content (capped per-tool) so the parent agent gets actionable data
 * even when the sub-agent model doesn't produce analysis text.
 */
export function buildToolResultsSummary(messages: any[]): string {
  const toolEntries: string[] = [];
  // Tools whose output should be passed through in full (they contain the
  // data the parent needs). Others get first-line summaries.
  const FULL_CONTENT_TOOLS = new Set([
    'read_file', 'search_workspace', 'get_document_symbols',
    'find_definition', 'find_references', 'find_symbol',
    'get_hover_info', 'get_call_hierarchy', 'find_implementations', 'get_type_hierarchy'
  ]);
  const MAX_PER_TOOL = 4000;

  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool_name || m.tool_name === '__ui__') continue;
    const content = (m.content || '').trim();
    if (!content) continue;

    const name = m.tool_name;

    if (FULL_CONTENT_TOOLS.has(name)) {
      // Include full tool output — this IS the data the parent needs
      if (content.length > MAX_PER_TOOL) {
        toolEntries.push(`- ${name}:\n${content.substring(0, MAX_PER_TOOL)}\n[... ${content.length - MAX_PER_TOOL} chars truncated]`);
      } else {
        toolEntries.push(`- ${name}:\n${content}`);
      }
    } else {
      // Brief summary for other tools
      const firstLine = content.split('\n')[0].substring(0, 120);
      toolEntries.push(`- ${name}: ${firstLine}`);
    }
  }
  if (toolEntries.length === 0) return 'Exploration completed.';
  // Cap total at 8K chars — the parent orchestrator (typically 128K+ context)
  // can handle this, and it's far more useful than a one-line summary.
  const joined = `Tool results summary:\n${toolEntries.join('\n')}`;
  return joined.length > 8000
    ? joined.substring(0, 8000) + '\n[Summary truncated]'
    : joined;
}

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

/**
 * Parameter object for AgentExploreExecutor.execute() — replaces 13 positional params.
 */
export interface ExploreExecuteParams {
  task: string;
  config: ExecutorConfig;
  token: vscode.CancellationToken;
  sessionId: string;
  model: string;
  mode?: ExploreMode;
  capabilities?: ModelCapabilities;
  conversationHistory?: MessageRecord[];
  isSubagent?: boolean;
  primaryWorkspaceHint?: vscode.WorkspaceFolder;
  subagentTitle?: string;
  subagentContextHint?: string;
  subagentDescription?: string;
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
   * @param params - Exploration parameters (task, config, model, mode, etc.)
   */
  async execute(params: ExploreExecuteParams): Promise<ExploreResult> {
    const {
      task, config, token, sessionId, model,
      mode = 'explore', capabilities: rawCapabilities,
      conversationHistory, isSubagent = false,
      primaryWorkspaceHint, subagentTitle, subagentContextHint, subagentDescription
    } = params;
    let capabilities = rawCapabilities;
    const allFolders = vscode.workspace.workspaceFolders || [];
    const primaryWorkspace = primaryWorkspaceHint || allFolders[0];
    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();

    // Resolve context window: capabilities DB > live /api/show > user config > Ollama default
    capabilities = await resolveContextWindow(this.client, model, capabilities, useNativeTools, this.outputChannel, 'AgentExploreExecutor');

    // Sub-agent mode: suppress text streaming, thinking, final message, AND
    // per-iteration progress group events. The sub-agent gets ONE wrapper
    // progress group (emitted before/after the loop) containing all tool
    // actions and thinking. Internal startProgressGroup/finishProgressGroup
    // are suppressed so actions funnel into the wrapper group.
    const subLabel = subagentTitle ? `Sub-agent: ${subagentTitle}` : 'Sub-agent';

    // Unified event emitter — guarantees every UI event is persisted + posted.
    // Sub-agent mode uses FilteredAgentEventEmitter to suppress internal
    // startProgressGroup/finishProgressGroup from the webview (the wrapper
    // group handles those).
    const events = isSubagent
      ? new FilteredAgentEventEmitter(sessionId, this.databaseService, this.emitter)
      : new AgentEventEmitter(sessionId, this.databaseService, this.emitter);

    // Stream processor emitter: sub-agents suppress streaming text events.
    const silentStreamEmitter: WebviewMessageEmitter = isSubagent
      ? {
          postMessage: (msg: any) => {
            if (SUB_AGENT_ALLOWED_TYPES.has(msg.type)) {
              this.emitter.postMessage(msg);
            }
          }
        }
      : this.emitter;
    const activeStreamProcessor = isSubagent
      ? new AgentStreamProcessor(this.client, silentStreamEmitter)
      : this.streamProcessor;

    // Build mode-specific system prompt
    await this.promptBuilder.loadProjectContext(primaryWorkspace);
    const systemContent = this.buildSystemPrompt(mode, allFolders, primaryWorkspace, useNativeTools, isSubagent, subagentContextHint);

    // Build messages array with conversation history for multi-turn context.
    // CRITICAL: Include role:'tool' messages so the model sees its own prior
    // tool calls and results. Without these, the model loses memory of what
    // it already did and will restate plans and re-do searches each turn.
    const history = new ConversationHistory({
      systemPrompt: systemContent,
      conversationHistory: conversationHistory || [],
      userTask: task,
      useNativeTools
    });
    const messages = history.messages;

    if (!useNativeTools) {
      events.post('showWarningBanner', {
        message: 'This model doesn\'t natively support tool calling. Using text-based tool parsing.'
      });
    }

    // Sub-agent wrapper group: single group containing all sub-agent actions
    if (isSubagent) {
      await events.emit('startProgressGroup', { title: subLabel, isSubagent: true });

      // Emit description as the first action inside the group so it isn't empty
      // while the sub-agent is starting up. Transitions to ✓ when group finishes.
      if (subagentDescription) {
        const descPayload = { status: 'running', icon: '📋', text: subagentDescription };
        await events.emit('showToolAction', descPayload);
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
      logIterationState(this.outputChannel, `Explore`, iteration, messages);

      let phase = 'preparing request';

      try {
        // Context compaction for long explorations
        const contextWindow = computeEffectiveContextWindow(capabilities);
        if (iteration > 1) {
          await compactAndEmit(this.contextCompactor, messages, contextWindow, model, lastPromptTokens, events, this.outputChannel, mode, iteration, { isSubagent });
        }

        // DEFENSIVE: Strip thinking from ALL history messages before sending.
        history.prepareForRequest();

        // Build chat request — pick the mode-specific config for temperature/maxTokens
        const modeConfigMap: Record<string, 'chatMode' | 'planMode' | 'agentMode'> = {
          chat: 'chatMode', plan: 'planMode', explore: 'agentMode',
          'deep-explore': 'agentMode', review: 'agentMode',
        };
        const modeConfig = getConfig()[modeConfigMap[mode] || 'agentMode'];
        const toolDefsForMode = useNativeTools ? this.getToolDefinitions(mode) : undefined;

        const chatRequest = buildChatRequest(
          model, messages, modeConfig, contextWindow, useNativeTools,
          toolDefsForMode, agentConfig.keepAlive
        );

        // --- Diagnostic: log request payload sizes for debugging slow models ---
        logRequestPayload(this.outputChannel, mode, iteration, messages, chatRequest);

        if (iteration > 1) {
          events.post('iterationBoundary', {});
        }

        phase = 'streaming response from model';
        const thinkingStartTime = Date.now();
        const streamResult = await activeStreamProcessor.streamIteration(
            chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime,
            this.toolRegistry.getToolNames()
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
            const recovered = recoverToolCallFromError(errText, nativeToolCalls, this.outputChannel, mode, iteration);
            if (recovered) {
              recoveredToolCalls.push(recovered);
            }
          }
        }

        // Update real token counts for context compactor (used next iteration)
        const tokenResult = trackPromptTokens(
          messages, streamResult.promptTokens, streamResult.completionTokens,
          contextWindow, this.outputChannel, mode, iteration
        );
        if (tokenResult.lastPromptTokens != null) {
          lastPromptTokens = tokenResult.lastPromptTokens;
        }

        // Emit token usage to the webview for the live indicator
        if (!isSubagent) {
          const toolDefCount = useNativeTools ? this.getToolDefinitions(mode).length : 0;
          await emitTokenUsage(events, messages, toolDefCount, lastPromptTokens, streamResult.completionTokens, contextWindow);
        }

        if (token.isCancellationRequested) {
          // Persist any accumulated thinking content before breaking so it
          // survives session restore.
          if (!isSubagent) {
            await persistCancellationThinking(events, thinkingContent, thinkingStartTime, streamResult.lastThinkingTimestamp, streamResult.thinkingCollapsed);
          }
          break;
        }

        // Log iteration
        this.outputChannel.appendLine(`\n[${mode}][Iteration ${iteration}] Response: ${response.substring(0, 300)}...`);

        // De-duplicate thinking echo
        response = deduplicateThinkingEcho(response, thinkingContent);

        // Persist thinking block (skip for sub-agents — their thinking is internal)
        const thinkResult = await persistThinkingBlock(
          events, thinkingContent, thinkingStartTime,
          streamResult.lastThinkingTimestamp, streamResult.thinkingCollapsed,
          { isSubagent, accumulatedSubagentThinking }
        );
        if (thinkResult.accumulatedSubagentThinking !== undefined) {
          accumulatedSubagentThinking = thinkResult.accumulatedSubagentThinking;
        }

        // Process text — ALWAYS strip tool call patterns from the response,
        // even in native mode. Some models (e.g. Qwen2.5-Coder) output tool
        // call JSON as text in the content field even when native tool_calls
        // are also present. Without stripping, the raw JSON leaks into
        // accumulatedExplanation and becomes the sub-agent output to the parent.
        const cleanedText = removeToolCalls(response);
        const iterationDelta = cleanedText
          .replace(/\[TASK_COMPLETE\]/gi, '')
          .replace(/\[END_OF_EXPLORATION\]/gi, '')
          .trim();

        if (iterationDelta) {
          if (accumulatedExplanation) accumulatedExplanation += '\n\n';
          accumulatedExplanation += iterationDelta;

          if (!isSubagent) {
            events.post('streamChunk', { content: iterationDelta, model });
            if (sessionId) {
              await this.databaseService.addMessage(sessionId, 'assistant', iterationDelta, { model });
              hasPersistedIterationText = true;
            }
          }
        }

        // Check for completion — also check thinkingContent for thinking models.
        // ONLY accept [TASK_COMPLETE]. Do NOT accept loose variants like
        // 'task is complete' or '[end_of_exploration]' — models use these to
        // escape the loop after 0 tool calls.
        const completionSignal = (response + ' ' + thinkingContent).toLowerCase();
        if (completionSignal.includes('[task_complete]')) {
          break;
        }

        // Extract tool calls
        phase = 'parsing tool calls';
        let toolCalls = parseToolCalls(response, nativeToolCalls, useNativeTools, this.toolRegistry.getToolNames());

        // Merge in any tool calls recovered from Ollama parse errors
        if (toolCalls.length === 0 && recoveredToolCalls.length > 0) {
          toolCalls = recoveredToolCalls;
          this.outputChannel.appendLine(`[${mode}][Iteration ${iteration}] Using ${recoveredToolCalls.length} recovered tool call(s)`);
        }

        // Filter out any non-read-only tools that the model might try to call
        const allowedSet = getToolsForMode(mode);
        let filteredToolCalls = toolCalls.filter(tc => allowedSet.has(tc.name));

        if (filteredToolCalls.length < toolCalls.length) {
          const blocked = toolCalls.filter(tc => !allowedSet.has(tc.name)).map(tc => tc.name);
          this.outputChannel.appendLine(`[${mode}] Blocked non-read-only tools: ${blocked.join(', ')}`);
        }

        if (filteredToolCalls.length === 0) {
          consecutiveNoToolIterations++;
          history.addAssistantMessage(response, thinkingContent);

          // Smart completion detection (pure function — see agentControlPlane.ts).
          // Sub-agents are read-only and never write files — passing
          // hasWrittenFiles=true would cause break_implicit on the first
          // empty response, killing sub-agents before they can retry.
          // Non-sub-agent explore modes pass true so empty responses
          // (common after completion) trigger immediate termination.
          const completionAction = checkNoToolCompletion({
            response, thinkingContent, hasWrittenFiles: !isSubagent, consecutiveNoToolIterations
          });

          if (completionAction !== 'continue') {
            this.outputChannel.appendLine(`[${mode}] Breaking: ${completionAction}`);
            break;
          }

          if (iteration < maxIterations - 1) {
            history.addContinuation('If you are done, respond with [TASK_COMPLETE]. Otherwise, continue using tools.');
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
          await events.emit('startProgressGroup', { title: groupTitle });
        }

        // NO thinking field in history — see Ollama issue #10448.
        // CRITICAL: Prefer the compact tool summary over the model's verbose
        // planning text. The response was already streamed to the UI, but
        // keeping it in history causes the model to see its own plan and
        // restate it every iteration (see Pitfall #38).
        const toolSummary = buildToolCallSummary(filteredToolCalls);
        await buildAndPersistAssistantToolMessage(
          filteredToolCalls, nativeToolCalls, response, thinkingContent,
          useNativeTools, messages, sessionId, this.databaseService,
          hasPersistedIterationText, model, toolSummary
        );

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
          events.post('showToolAction', { status: 'running', icon: actionIcon, text: actionText, detail: actionDetail });
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
              events.post('showToolAction', successPayload);
            }
            await events.persist('showToolAction', successPayload);
            return { toolCall, idx, output, error: undefined as string | undefined };
          } catch (error: any) {
            const errorPayload = { status: 'error' as const, icon: actionIcon, text: actionText, detail: error.message };
            await events.emit('showToolAction', errorPayload);
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
            events.post('showToolAction', { status: 'running', icon: actionIcon, text: actionText, detail: actionDetail });
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
          await events.emit('finishProgressGroup', {});
        }

        // Feed results back. NO task reminder — the full task is in messages[1].
        // Adding a truncated preview caused models to fixate on the incomplete
        // snippet instead of referencing the original user message.
        if (useNativeTools) {
          history.addNativeToolResults(toolResults);
          history.addContinuation('Proceed with tool calls or [TASK_COMPLETE].');
        } else if (xmlResults.length > 0) {
          history.addXmlToolResults(xmlResults, 'Proceed with tool calls or [TASK_COMPLETE].');
        }
      } catch (error: any) {
        await buildAndEmitFatalError(
          events, error, model, `${mode}: ${phase}`, iteration, maxIterations,
          this.outputChannel, 'AgentExploreExecutor', messages
        );
        break;
      }
    }

    // Close sub-agent wrapper group
    if (isSubagent) {
      await events.emit('finishProgressGroup', {});
    }

    // Build final result — for sub-agents, fall back to thinking content
    // (thinking models put analysis in thinking field, not response) and
    // then to a tool results summary so the parent gets useful data.
    let summary: string;
    if (isSubagent && accumulatedExplanation) {
      // Sub-agents: narration alone is usually vague ("I will read...").
      // Append tool results summary so the parent gets actionable data.
      const toolSummary = buildToolResultsSummary(messages);
      summary = (toolSummary && toolSummary !== 'Exploration completed.')
        ? accumulatedExplanation + '\n\n' + toolSummary
        : accumulatedExplanation;
    } else if (accumulatedExplanation) {
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
      summary = buildToolResultsSummary(messages);
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
        const finalContent = summary.replace(/\[TASK_COMPLETE\]/gi, '').replace(/\[END_OF_EXPLORATION\]/gi, '').trim();
        if (finalContent) {
          events.post('finalMessage', { content: finalContent, model });
        }
      } else {
        // Text already streamed — just signal generation end via empty finalMessage.
        // This resets currentStreamIndex in the webview so the next user
        // message starts a fresh assistant thread (Critical Rule #3).
        events.post('finalMessage', { content: '', model });
      }
      events.post('hideThinking', {});
    }

    const cleanedSummary = summary.replace(/\[TASK_COMPLETE\]/gi, '').replace(/\[END_OF_EXPLORATION\]/gi, '').trim();
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
    const result = await this.execute({
      task, config, token, sessionId, model, mode, capabilities,
      isSubagent: true, primaryWorkspaceHint,
      subagentTitle: title, subagentContextHint: contextHint, subagentDescription: description
    });
    return result.summary || 'Sub-agent completed with no findings.';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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

}
