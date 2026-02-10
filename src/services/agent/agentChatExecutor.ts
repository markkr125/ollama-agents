import * as vscode from 'vscode';
import { SessionManager } from '../../agent/sessionManager';
import { ToolRegistry } from '../../agent/toolRegistry';
import { getConfig } from '../../config/settings';
import { ExecutorConfig } from '../../types/agent';
import { MessageRecord } from '../../types/session';
import { extractToolCalls, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getProgressGroupTitle } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { ModelCapabilities } from '../model/modelCompatibility';
import { OllamaClient } from '../model/ollamaClient';
import { PendingEditDecorationProvider } from '../pendingEditDecorationProvider';
import { TerminalManager } from '../terminalManager';
import { AgentFileEditHandler } from './agentFileEditHandler';
import { AgentStreamProcessor } from './agentStreamProcessor';
import { AgentSummaryBuilder } from './agentSummaryBuilder';
import { AgentTerminalHandler } from './agentTerminalHandler';
import { AgentToolRunner } from './agentToolRunner';
import { ApprovalManager } from './approvalManager';
import { CheckpointManager } from './checkpointManager';

// ---------------------------------------------------------------------------
// AgentChatExecutor — orchestrates the agent loop. Delegates streaming,
// tool execution, summary building, file edits, terminal commands, and
// checkpoint management to dedicated sub-handlers.
// ---------------------------------------------------------------------------

export class AgentChatExecutor {
  private readonly approvalManager: ApprovalManager;
  private readonly terminalHandler: AgentTerminalHandler;
  private readonly fileEditHandler: AgentFileEditHandler;
  private readonly streamProcessor: AgentStreamProcessor;
  private readonly toolRunner: AgentToolRunner;
  private readonly summaryBuilder: AgentSummaryBuilder;
  readonly checkpointManager: CheckpointManager;
  private editManager: EditManager;

  constructor(
    private readonly client: OllamaClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly sessionManager: SessionManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly emitter: WebviewMessageEmitter,
    private readonly refreshExplorer: () => void,
    private readonly terminalManager: TerminalManager,
    private readonly decorationProvider: PendingEditDecorationProvider
  ) {
    this.editManager = new EditManager(this.client);
    this.approvalManager = new ApprovalManager();

    const persistFn = this.persistUiEvent.bind(this);

    this.terminalHandler = new AgentTerminalHandler(
      this.toolRegistry,
      this.databaseService,
      this.emitter,
      this.approvalManager,
      persistFn,
      this.outputChannel
    );

    this.fileEditHandler = new AgentFileEditHandler(
      this.toolRegistry,
      this.databaseService,
      this.editManager,
      this.emitter,
      this.approvalManager,
      persistFn,
      this.outputChannel
    );

    this.checkpointManager = new CheckpointManager(
      this.databaseService,
      this.editManager,
      this.decorationProvider,
      this.refreshExplorer,
      this.outputChannel
    );

    this.streamProcessor = new AgentStreamProcessor(this.client, this.emitter);

    this.toolRunner = new AgentToolRunner(
      this.toolRegistry,
      this.databaseService,
      this.emitter,
      this.terminalHandler,
      this.fileEditHandler,
      this.checkpointManager,
      this.decorationProvider,
      persistFn,
      this.refreshExplorer
    );

    this.summaryBuilder = new AgentSummaryBuilder(this.client, this.databaseService, this.emitter);
  }

  // -------------------------------------------------------------------------
  // Public helpers delegated from chatView
  // -------------------------------------------------------------------------

  handleToolApprovalResponse(approvalId: string, approved: boolean, command?: string): void {
    this.approvalManager.handleResponse(approvalId, approved, command);
  }

  /** Open diff for a cached file-edit approval entry. */
  async openFileDiff(approvalId: string): Promise<void> {
    return this.fileEditHandler.openFileDiff(approvalId);
  }

  // -- Checkpoint pass-throughs -----------------------------------------------

  async openFileChangeDiff(checkpointId: string, filePath: string): Promise<void> {
    return this.checkpointManager.openFileChangeDiff(checkpointId, filePath);
  }

  async openSnapshotDiff(checkpointId: string | undefined, filePath: string, sessionId?: string): Promise<void> {
    return this.checkpointManager.openSnapshotDiff(checkpointId, filePath, sessionId);
  }

  async keepFile(checkpointId: string, filePath: string): Promise<{ success: boolean }> {
    return this.checkpointManager.keepFile(checkpointId, filePath);
  }

  async undoFile(checkpointId: string, filePath: string): Promise<{ success: boolean }> {
    return this.checkpointManager.undoFile(checkpointId, filePath);
  }

  async markFileUndone(checkpointId: string, filePath: string): Promise<void> {
    return this.checkpointManager.markFileUndone(checkpointId, filePath);
  }

  async keepAllChanges(checkpointId: string): Promise<{ success: boolean }> {
    return this.checkpointManager.keepAllChanges(checkpointId);
  }

  async undoAllChanges(checkpointId: string): Promise<{ success: boolean; errors: string[] }> {
    return this.checkpointManager.undoAllChanges(checkpointId);
  }

  async computeFilesDiffStats(checkpointId: string): Promise<Array<{ path: string; additions: number; deletions: number; action: string }>> {
    return this.checkpointManager.computeFilesDiffStats(checkpointId);
  }

  // -------------------------------------------------------------------------
  // Persist + post UI events
  // -------------------------------------------------------------------------

  async persistUiEvent(
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

  /**
   * Persist + post a git branch creation as a full progress group.
   * Called from chatView.ts so session history matches live chat.
   */
  async persistGitBranchAction(sessionId: string, branchName: string): Promise<void> {
    const title = 'Git setup';
    await this.persistUiEvent(sessionId, 'startProgressGroup', { title });
    this.emitter.postMessage({ type: 'startProgressGroup', title, sessionId });

    const action = { status: 'success' as const, icon: '📌', text: `Created branch: ${branchName}`, detail: branchName };
    await this.persistUiEvent(sessionId, 'showToolAction', action);
    this.emitter.postMessage({ type: 'showToolAction', ...action, sessionId });

    await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
    this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
  }

  // -------------------------------------------------------------------------
  // Main agent execution loop
  // -------------------------------------------------------------------------

  async execute(
    agentSession: any,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    sessionId: string,
    model: string,
    capabilities?: ModelCapabilities
  ): Promise<{ summary: string; assistantMessage: MessageRecord; checkpointId?: string }> {
    const context = {
      workspace: agentSession.workspace,
      token,
      outputChannel: this.outputChannel,
      sessionId,
      terminalManager: this.terminalManager
    };

    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();
    const useThinking = agentConfig.enableThinking && useNativeTools;

    const workspacePath = agentSession.workspace?.uri?.fsPath || '';
    const systemContent = useNativeTools
      ? `You are a coding agent. Use the provided tools to complete tasks. The workspace root is: ${workspacePath}. All file paths are relative to this workspace. Terminal commands run in this directory by default. When done, respond with [TASK_COMPLETE].`
      : this.buildAgentSystemPrompt();

    const messages: any[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: agentSession.task }
    ];

    if (!useNativeTools) {
      this.emitter.postMessage({
        type: 'showWarningBanner',
        message: 'This model doesn\'t natively support tool calling. Agent mode will use text-based tool parsing, which may be less reliable. Consider using a model like llama3.1+, qwen2.5+, or mistral.',
        sessionId
      });
    }

    let iteration = 0;
    let accumulatedExplanation = '';
    let hasWrittenFiles = false;
    let hasPersistedIterationText = false;

    let currentCheckpointId: string | undefined;
    try {
      currentCheckpointId = await this.databaseService.createCheckpoint(sessionId);
    } catch (err) {
      console.warn('[AgentChatExecutor] Failed to create checkpoint:', err);
    }

    const taskLower = agentSession.task.toLowerCase();
    const taskRequiresWrite = /\b(rename|change|modify|edit|update|add|create|write|fix|refactor|remove|delete)\b/.test(taskLower);

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      try {
        // --- 1. Stream LLM response ---
        const chatRequest: any = { model, messages };
        if (useNativeTools) {
          chatRequest.tools = this.toolRegistry.getOllamaToolDefinitions();
        }
        if (useThinking) {
          chatRequest.think = true;
        }

        const streamResult = await this.streamProcessor.streamIteration(
          chatRequest, sessionId, model, iteration, useNativeTools, token
        );

        let { response } = streamResult;
        const { thinkingContent, nativeToolCalls } = streamResult;

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          break;
        }

        // --- 2. Log iteration response ---
        this.logIterationResponse(iteration, response, thinkingContent, nativeToolCalls);

        // De-duplicate: some models echo thinking content in response too
        if (thinkingContent.trim() && response.trim()) {
          const thinkTrimmed = thinkingContent.trim();
          const respTrimmed = response.trim();
          if (respTrimmed === thinkTrimmed ||
              respTrimmed.startsWith(thinkTrimmed) ||
              thinkTrimmed.startsWith(respTrimmed)) {
            response = '';
          }
        }

        // --- 3. Persist thinking block (BEFORE text and tools — order matters for history) ---
        const displayThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
        if (displayThinking) {
          await this.persistUiEvent(sessionId, 'thinkingBlock', { content: displayThinking });
          this.emitter.postMessage({ type: 'collapseThinking', sessionId });
        }

        // --- 4. Process per-iteration delta text ---
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.trim();

        if (iterationDelta && !iterationDelta.includes('[TASK_COMPLETE]')) {
          if (accumulatedExplanation) {
            accumulatedExplanation += '\n\n';
          }
          accumulatedExplanation += iterationDelta;

          this.emitter.postMessage({
            type: 'streamChunk',
            content: iterationDelta,
            model,
            sessionId
          });

          if (sessionId) {
            await this.databaseService.addMessage(sessionId, 'assistant', iterationDelta, { model });
            hasPersistedIterationText = true;
          }
        }

        // --- 5. Check for [TASK_COMPLETE] ---
        if (response.includes('[TASK_COMPLETE]') || response.toLowerCase().includes('task is complete')) {
          if (taskRequiresWrite && !hasWrittenFiles) {
            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: 'You said the task is complete, but no files were modified. You must use write_file to actually make changes. Reading a file does not modify it. Please complete the task by calling write_file with the modified content.'
            });
            continue;
          }
          const completionText = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();
          accumulatedExplanation = completionText || accumulatedExplanation;

          if (completionText && sessionId) {
            await this.databaseService.addMessage(sessionId, 'assistant', completionText, { model });
            hasPersistedIterationText = true;
          }
          break;
        }

        // --- 6. Extract tool calls ---
        const toolCalls = this.parseToolCalls(response, nativeToolCalls, useNativeTools);

        this.outputChannel.appendLine(`[Iteration ${iteration}] Parsed ${toolCalls.length} tool calls (${useNativeTools ? 'native' : 'XML'}):`);
        toolCalls.forEach((tc, i) => this.outputChannel.appendLine(`  [${i}] ${tc.name}: ${JSON.stringify(tc.args)}`));
        this.outputChannel.appendLine('---');

        if (toolCalls.length === 0) {
          const noToolMsg: any = { role: 'assistant', content: response };
          if (thinkingContent) noToolMsg.thinking = thinkingContent;
          messages.push(noToolMsg);
          if (iteration < config.maxIterations - 1) {
            messages.push({
              role: 'user',
              content: 'Continue with the task. Use tools or respond with [TASK_COMPLETE] if finished.'
            });
          }
          continue;
        }

        // --- 7. Execute tool batch ---
        const groupTitle = getProgressGroupTitle(toolCalls);
        this.emitter.postMessage({ type: 'startProgressGroup', title: groupTitle, sessionId });
        await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });

        // Push assistant message to conversation history
        const assistantMsg: any = { role: 'assistant', content: response };
        if (thinkingContent) assistantMsg.thinking = thinkingContent;
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        const batchResult = await this.toolRunner.executeBatch(
          toolCalls, context, sessionId, model, groupTitle,
          currentCheckpointId, agentSession, useNativeTools, token
        );

        if (batchResult.wroteFiles) {
          hasWrittenFiles = true;
        }

        this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
        await this.persistUiEvent(sessionId, 'finishProgressGroup', {});

        // Feed tool results back into conversation history
        if (useNativeTools) {
          messages.push(...batchResult.nativeResults);
        } else if (batchResult.xmlResults.length > 0) {
          messages.push({
            role: 'user',
            content: batchResult.xmlResults.join('\n\n') + '\n\nContinue with the task.'
          });
        }
      } catch (error: any) {
        await this.persistUiEvent(sessionId, 'showError', { message: error.message });
        this.emitter.postMessage({ type: 'showError', message: error.message, sessionId });
        break;
      }
    }

    // --- Post-loop: mark session complete + build summary ---
    this.sessionManager.updateSession(agentSession.id, { status: 'completed' });

    const { summary, assistantMessage } = await this.summaryBuilder.finalize(
      sessionId, model, agentSession,
      accumulatedExplanation, hasPersistedIterationText, currentCheckpointId
    );

    return { summary, assistantMessage, checkpointId: currentCheckpointId || undefined };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Parse tool calls from either native API response or XML text. */
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

  /** Write iteration details to the output channel for debugging. */
  private logIterationResponse(
    iteration: number,
    response: string,
    thinkingContent: string,
    nativeToolCalls: any[]
  ): void {
    this.outputChannel.appendLine(`\n[Iteration ${iteration}] Full LLM response:`);
    this.outputChannel.appendLine(response);
    if (thinkingContent) {
      this.outputChannel.appendLine(`[Thinking] ${thinkingContent.substring(0, 500)}`);
    }
    if (nativeToolCalls.length > 0) {
      this.outputChannel.appendLine(`[Native tool_calls] ${JSON.stringify(nativeToolCalls)}`);
    }
    this.outputChannel.appendLine('---');
  }

  /** Build XML fallback system prompt with all tool definitions. */
  private buildAgentSystemPrompt(): string {
    const tools = this.toolRegistry.getAll();
    const toolDescriptions = tools.map((t: { name: string; description: string; schema?: any }) => {
      const params = t.schema?.properties
        ? Object.entries(t.schema.properties)
            .map(([key, val]: [string, any]) => `    ${key}: ${val.description || val.type}`)
            .join('\n')
        : '    (no parameters)';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n');

    return `You are a coding agent. You MUST use tools to complete tasks. Never claim to do something without using tools.

TOOLS:
${toolDescriptions}

FORMAT - Always use this exact format:
<tool_call>{"name": "TOOL_NAME", "arguments": {"arg": "value"}}</tool_call>

EXAMPLES:
<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>
<tool_call>{"name": "write_file", "arguments": {"path": "file.txt", "content": "new content"}}</tool_call>

CRITICAL: To edit a file you must call write_file. Reading alone does NOT change files.

When done: [TASK_COMPLETE]`;
  }
}
