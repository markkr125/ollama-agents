import * as vscode from 'vscode';
import { ToolRegistry } from '../../agent/toolRegistry';
import { getConfig } from '../../config/settings';
import { ExecutorConfig } from '../../types/agent';
import { OllamaError } from '../../types/ollama';
import { MessageRecord } from '../../types/session';
import { extractToolCalls, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getProgressGroupTitle } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { ModelCapabilities } from '../model/modelCompatibility';
import { OllamaClient } from '../model/ollamaClient';
import { AgentContextCompactor } from './agentContextCompactor';
import { AgentPromptBuilder } from './agentPromptBuilder';
import { AgentStreamProcessor } from './agentStreamProcessor';

// ---------------------------------------------------------------------------
// Read-only tool names — only these tools are allowed in explore/plan modes.
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
  'get_document_symbols', 'find_definition', 'find_references',
  'find_implementations', 'find_symbol', 'get_hover_info',
  'get_call_hierarchy', 'get_type_hierarchy',
]);

// ---------------------------------------------------------------------------
// AgentExploreExecutor — read-only exploration agent. Same streaming loop
// as AgentChatExecutor but restricted to read-only tools. No checkpoints,
// no approval flow, no file writes.
// ---------------------------------------------------------------------------

export type ExploreMode = 'explore' | 'plan' | 'review';

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
    conversationHistory?: MessageRecord[]
  ): Promise<ExploreResult> {
    const allFolders = vscode.workspace.workspaceFolders || [];
    const primaryWorkspace = allFolders[0];
    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();
    let useThinking = agentConfig.enableThinking && useNativeTools;

    // Build mode-specific system prompt
    await this.promptBuilder.loadProjectContext(primaryWorkspace);
    const systemContent = this.buildSystemPrompt(mode, allFolders, primaryWorkspace, useNativeTools);

    // Build messages array with conversation history for multi-turn context
    const historyMessages = (conversationHistory || [])
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.tool_name !== '__ui__' && m.content.trim())
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const messages: any[] = [
      { role: 'system', content: systemContent },
      ...historyMessages,
      { role: 'user', content: task }
    ];

    if (!useNativeTools) {
      this.emitter.postMessage({
        type: 'showWarningBanner',
        message: 'This model doesn\'t natively support tool calling. Using text-based tool parsing.',
        sessionId
      });
    }

    // For read-only modes, cap iterations lower than agent mode (default 10)
    const maxIterations = Math.min(config.maxIterations, mode === 'review' ? 15 : 10);
    let iteration = 0;
    let accumulatedExplanation = '';
    let hasPersistedIterationText = false;
    let consecutiveNoToolIterations = 0;

    while (iteration < maxIterations && !token.isCancellationRequested) {
      iteration++;

      try {
        // Context compaction for long explorations
        const contextWindow = getConfig().contextWindow || 16000;
        if (iteration > 2) {
          await this.contextCompactor.compactIfNeeded(messages, contextWindow, model);
        }

        // Build chat request
        const chatRequest: any = { model, messages };
        if (useNativeTools) {
          chatRequest.tools = this.getToolDefinitions(mode);
        }
        if (useThinking) {
          chatRequest.think = true;
        }

        if (iteration > 1) {
          this.emitter.postMessage({ type: 'iterationBoundary', sessionId });
        }

        const thinkingStartTime = Date.now();
        let streamResult;
        try {
          streamResult = await this.streamProcessor.streamIteration(
            chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime
          );
        } catch (thinkErr: any) {
          if (useThinking && thinkErr instanceof OllamaError && thinkErr.statusCode === 400) {
            useThinking = false;
            delete chatRequest.think;
            streamResult = await this.streamProcessor.streamIteration(
              chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime
            );
          } else {
            throw thinkErr;
          }
        }

        let { response } = streamResult;
        const { thinkingContent, nativeToolCalls } = streamResult;

        if (token.isCancellationRequested) break;

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

        // Persist thinking block
        const displayThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
        if (displayThinking) {
          const thinkingEndTime = streamResult.lastThinkingTimestamp || Date.now();
          const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
          await this.persistUiEvent(sessionId, 'thinkingBlock', { content: displayThinking, durationSeconds });
          if (!streamResult.thinkingCollapsed) {
            this.emitter.postMessage({ type: 'collapseThinking', sessionId, durationSeconds });
          }
        }

        // Process text
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();

        if (iterationDelta) {
          if (accumulatedExplanation) accumulatedExplanation += '\n\n';
          accumulatedExplanation += iterationDelta;

          this.emitter.postMessage({ type: 'streamChunk', content: iterationDelta, model, sessionId });
          if (sessionId) {
            await this.databaseService.addMessage(sessionId, 'assistant', iterationDelta, { model });
            hasPersistedIterationText = true;
          }
        }

        // Check for completion
        if (response.includes('[TASK_COMPLETE]') || response.toLowerCase().includes('task is complete')) {
          break;
        }

        // Extract tool calls
        const toolCalls = this.parseToolCalls(response, nativeToolCalls, useNativeTools);

        // Filter out any non-read-only tools that the model might try to call
        const allowedSet = mode === 'review' ? this.getSecurityReviewToolNames() : READ_ONLY_TOOLS;
        const filteredToolCalls = toolCalls.filter(tc => allowedSet.has(tc.name));

        if (filteredToolCalls.length < toolCalls.length) {
          const blocked = toolCalls.filter(tc => !allowedSet.has(tc.name)).map(tc => tc.name);
          this.outputChannel.appendLine(`[${mode}] Blocked non-read-only tools: ${blocked.join(', ')}`);
        }

        if (filteredToolCalls.length === 0) {
          consecutiveNoToolIterations++;
          const noToolMsg: any = { role: 'assistant', content: response };
          if (thinkingContent) noToolMsg.thinking = thinkingContent;
          messages.push(noToolMsg);

          if (consecutiveNoToolIterations >= 2) break;

          if (iteration < maxIterations - 1) {
            messages.push({
              role: 'user',
              content: 'Continue exploring. Use tools to find more information or respond with [TASK_COMPLETE] if finished.'
            });
          }
          continue;
        }

        consecutiveNoToolIterations = 0;

        // Execute read-only tools
        const groupTitle = getProgressGroupTitle(filteredToolCalls);
        this.emitter.postMessage({ type: 'startProgressGroup', title: groupTitle, sessionId });
        await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });

        const assistantMsg: any = { role: 'assistant', content: response };
        if (thinkingContent) assistantMsg.thinking = thinkingContent;
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        const context = {
          workspace: primaryWorkspace,
          workspaceFolders: allFolders,
          token,
          outputChannel: this.outputChannel,
          sessionId
        };

        const toolResults: Array<{ role: 'tool'; content: string; tool_name: string }> = [];
        const xmlResults: string[] = [];

        for (const toolCall of filteredToolCalls) {
          if (token.isCancellationRequested) break;

          try {
            const result = await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            const output = result.output || '';

            // Show tool action in UI
            const fileName = (toolCall.args?.path || toolCall.args?.file || '').split('/').pop() || toolCall.name;
            const successPayload = {
              status: 'success' as const,
              icon: '🔍',
              text: `${toolCall.name}: ${fileName}`,
              detail: output.split('\n')[0]?.substring(0, 100) || ''
            };
            this.emitter.postMessage({ type: 'showToolAction', ...successPayload, sessionId });
            await this.persistUiEvent(sessionId, 'showToolAction', successPayload);

            // Persist to DB
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
          } catch (error: any) {
            const errOutput = `Error: ${error.message}`;
            const errorPayload = {
              status: 'error' as const,
              icon: '🔍',
              text: toolCall.name,
              detail: error.message
            };
            this.emitter.postMessage({ type: 'showToolAction', ...errorPayload, sessionId });
            await this.persistUiEvent(sessionId, 'showToolAction', errorPayload);

            if (useNativeTools) {
              toolResults.push({ role: 'tool', content: errOutput, tool_name: toolCall.name });
            } else {
              xmlResults.push(`Tool ${toolCall.name} failed: ${error.message}`);
            }
          }
        }

        this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
        await this.persistUiEvent(sessionId, 'finishProgressGroup', {});

        // Feed results back
        if (useNativeTools) {
          messages.push(...toolResults);
        } else if (xmlResults.length > 0) {
          messages.push({
            role: 'user',
            content: xmlResults.join('\n\n') + '\n\nContinue with your analysis.'
          });
        }
      } catch (error: any) {
        await this.persistUiEvent(sessionId, 'showError', { message: error.message });
        this.emitter.postMessage({ type: 'showError', message: error.message, sessionId });
        break;
      }
    }

    // Build final result
    const summary = accumulatedExplanation || 'Exploration completed.';
    const assistantMessage = hasPersistedIterationText
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

    const cleanedSummary = summary.replace(/\[TASK_COMPLETE\]/gi, '').trim();
    if (cleanedSummary) {
      this.emitter.postMessage({ type: 'finalMessage', content: cleanedSummary, model, sessionId });
    }
    this.emitter.postMessage({ type: 'hideThinking', sessionId });

    return { summary: cleanedSummary, assistantMessage };
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
      default:
        return this.promptBuilder.buildExplorePrompt(folders, primary, useNativeTools);
    }
  }

  private getToolDefinitions(mode: ExploreMode): any[] {
    if (mode === 'review') {
      return this.promptBuilder.getSecurityReviewToolDefinitions();
    }
    return this.promptBuilder.getReadOnlyToolDefinitions();
  }

  private getSecurityReviewToolNames(): Set<string> {
    return new Set([...READ_ONLY_TOOLS, 'run_terminal_command']);
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
