import * as vscode from 'vscode';
import { SessionManager } from '../../agent/sessionManager';
import { ToolRegistry } from '../../agent/toolRegistry';
import { resolveMultiRootPath } from '../../agent/tools/pathUtils';
import { getConfig } from '../../config/settings';
import { ExecutorConfig } from '../../types/agent';
import { ContinuationStrategy } from '../../types/config';
import { OllamaError } from '../../types/ollama';
import { MessageRecord } from '../../types/session';
import { formatDiagnostics, getErrorDiagnostics, waitForDiagnostics } from '../../utils/diagnosticWaiter';
import { extractToolCalls, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getProgressGroupTitle } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { ModelCapabilities } from '../model/modelCompatibility';
import { OllamaClient } from '../model/ollamaClient';
import { PendingEditDecorationProvider } from '../pendingEditDecorationProvider';
import { TerminalManager } from '../terminalManager';
import { AgentContextCompactor } from './agentContextCompactor';
import { AgentExploreExecutor } from './agentExploreExecutor';
import { AgentFileEditHandler } from './agentFileEditHandler';
import { AgentPromptBuilder } from './agentPromptBuilder';
import { AgentSessionMemory } from './agentSessionMemory';
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
  private readonly promptBuilder: AgentPromptBuilder;
  private readonly contextCompactor: AgentContextCompactor;
  private readonly streamProcessor: AgentStreamProcessor;
  private readonly toolRunner: AgentToolRunner;
  private readonly summaryBuilder: AgentSummaryBuilder;
  readonly checkpointManager: CheckpointManager;
  private editManager: EditManager;
  private _onFileWritten?: (checkpointId: string) => void;
  private _exploreExecutor?: AgentExploreExecutor;

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
      this.outputChannel,
      this.client
    );

    this.checkpointManager = new CheckpointManager(
      this.databaseService,
      this.editManager,
      this.decorationProvider,
      this.refreshExplorer,
      this.outputChannel
    );

    this.promptBuilder = new AgentPromptBuilder(this.toolRegistry);
    this.contextCompactor = new AgentContextCompactor(this.client);
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
      this.refreshExplorer,
      (checkpointId: string) => this._onFileWritten?.(checkpointId)
    );

    this.summaryBuilder = new AgentSummaryBuilder(this.client, this.databaseService, this.emitter);
  }

  // -------------------------------------------------------------------------
  // Public helpers delegated from chatView
  // -------------------------------------------------------------------------

  handleToolApprovalResponse(approvalId: string, approved: boolean, command?: string): void {
    this.approvalManager.handleResponse(approvalId, approved, command);
  }

  /** Register a callback invoked after each successful file write (e.g. to trigger CodeLens review). */
  set onFileWritten(cb: ((checkpointId: string) => void) | undefined) {
    this._onFileWritten = cb;
  }

  /** Set the explore executor for sub-agent tool support. */
  set exploreExecutor(executor: AgentExploreExecutor | undefined) {
    this._exploreExecutor = executor;
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

  async openAllEdits(checkpointIds: string[]): Promise<void> {
    return this.checkpointManager.openAllEdits(checkpointIds);
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
    capabilities?: ModelCapabilities,
    conversationHistory?: MessageRecord[]
  ): Promise<{ summary: string; assistantMessage: MessageRecord; checkpointId?: string }> {
    const context = {
      workspace: agentSession.workspace,
      workspaceFolders: vscode.workspace.workspaceFolders,
      token,
      outputChannel: this.outputChannel,
      sessionId,
      terminalManager: this.terminalManager,
      runSubagent: this._exploreExecutor
        ? async (task: string, mode: 'explore' | 'review') => {
            return this._exploreExecutor!.executeSubagent(task, token, sessionId, model, mode, capabilities);
          }
        : undefined
    };

    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();
    let useThinking = agentConfig.enableThinking && useNativeTools;

    const allFolders = vscode.workspace.workspaceFolders || [];

    // Load project context (reads package.json, CLAUDE.md, etc.) before prompt assembly
    await this.promptBuilder.loadProjectContext(agentSession.workspace);

    const systemContent = useNativeTools
      ? this.promptBuilder.buildNativeToolPrompt(allFolders, agentSession.workspace)
      : this.promptBuilder.buildXmlFallbackPrompt(allFolders, agentSession.workspace);

    // Build messages array with conversation history for multi-turn context
    const historyMessages = (conversationHistory || [])
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.tool_name !== '__ui__' && m.content.trim())
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const messages: any[] = [
      { role: 'system', content: systemContent },
      ...historyMessages,
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
    let consecutiveNoToolIterations = 0;

    let currentCheckpointId: string | undefined;
    try {
      currentCheckpointId = await this.databaseService.createCheckpoint(sessionId);
    } catch (err) {
      console.warn('[AgentChatExecutor] Failed to create checkpoint:', err);
    }

    const taskLower = agentSession.task.toLowerCase();
    const taskRequiresWrite = /\b(rename|change|modify|edit|update|add|create|write|fix|refactor|remove|delete|implement|move|replace|insert|append|prepend)\b/.test(taskLower);
    const taskRequiresTerminal = /\b(run|test|install|build|compile|execute|start|serve|deploy|lint|format|npm|yarn|pip|cargo|make|docker)\b/.test(taskLower);

    // Session memory — tracks discovered facts across iterations
    const sessionMemory = new AgentSessionMemory(this.outputChannel);
    const continuationStrategy: ContinuationStrategy = getConfig().agent.continuationStrategy || 'full';

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      try {
        // --- 0. Compact conversation history if approaching context limit ---
        const contextWindow = getConfig().contextWindow || 16000;
        if (iteration > 2) {
          // Inject session memory reminder into system prompt before compaction
          const memoryReminder = sessionMemory.toSystemReminder();
          if (memoryReminder && messages.length > 0 && messages[0].role === 'system') {
            // Strip any previous memory block and append fresh one
            const sysContent = messages[0].content.replace(/<session_memory>[\s\S]*?<\/session_memory>/g, '').trimEnd();
            messages[0].content = sysContent + '\n\n' + memoryReminder;
          }

          const compacted = await this.contextCompactor.compactIfNeeded(messages, contextWindow, model);
          if (compacted) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Context compacted — conversation history was summarized to free token budget.`);
          }
        }

        // --- 1. Stream LLM response ---
        const chatRequest: any = { model, messages };
        if (useNativeTools) {
          chatRequest.tools = this.toolRegistry.getOllamaToolDefinitions();
        }
        if (useThinking) {
          chatRequest.think = true;
        }

        // Signal the webview that a new iteration is starting so it can
        // save the existing text block content as a base prefix. Without this,
        // iteration 2's streaming (which starts from '') overwrites iteration 1's
        // text block content due to the replacement semantics of streamChunk.
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
          // Ollama returns 400 when `think: true` is sent to models that don't
          // support thinking. Detect this, disable thinking, and retry.
          if (useThinking && thinkErr instanceof OllamaError && thinkErr.statusCode === 400) {
            useThinking = false;
            delete chatRequest.think;
            this.outputChannel?.appendLine(`[Iteration ${iteration}] Model does not support thinking — retrying without think:true`);
            streamResult = await this.streamProcessor.streamIteration(
              chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime
            );
          } else {
            throw thinkErr;
          }
        }

        let { response } = streamResult;
        const { thinkingContent, nativeToolCalls, truncated } = streamResult;

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          break;
        }

        // Handle output truncation — the model hit the context/token limit mid-response.
        // Push a continuation message so it can resume from where it was cut off.
        if (truncated && response) {
          this.outputChannel.appendLine(`[Iteration ${iteration}] Output truncated by context limit — requesting continuation`);
          messages.push({ role: 'assistant', content: response });
          messages.push({
            role: 'user',
            content: 'Your response was cut off due to the output length limit. Continue EXACTLY where you left off — do not repeat what you already said. If you were in the middle of a tool call, re-emit the complete tool call.'
          });
          continue;
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
          // Use the timestamp of the last thinking token for accurate duration.
          // Without this, the duration includes Ollama's tool_call buffering
          // time (can be 60-80s for large files) which inflates the counter.
          const thinkingEndTime = streamResult.lastThinkingTimestamp || Date.now();
          const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
          await this.persistUiEvent(sessionId, 'thinkingBlock', { content: displayThinking, durationSeconds });
          // Only send collapseThinking if the stream processor didn't already
          // (it sends one early when native tool_calls are detected)
          if (!streamResult.thinkingCollapsed) {
            this.emitter.postMessage({ type: 'collapseThinking', sessionId, durationSeconds });
          }
        }

        // --- 4. Process per-iteration delta text ---
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();

        if (iterationDelta) {
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
              content: 'You indicated the task is complete, but NO files have been modified. Reading a file does NOT change it. You MUST call write_file with the modified content to actually make changes. If no changes are truly needed, explain why explicitly.'
            });
            continue;
          }
          if (taskRequiresTerminal && !hasWrittenFiles && !(agentSession.toolCalls || []).some((tc: any) => tc.tool === 'run_terminal_command' || tc.name === 'run_terminal_command')) {
            // Task looks like it needs a terminal command but none was run
            // Only nudge once — don't block completion if the model insists
            if (!agentSession._terminalNudgeSent) {
              agentSession._terminalNudgeSent = true;
              messages.push({ role: 'assistant', content: response });
              messages.push({
                role: 'user',
                content: 'You indicated the task is complete, but no terminal command was executed. If the task requires running a command (test, build, install, etc.), use run_terminal_command. If no command is needed, explain why and respond with [TASK_COMPLETE].'
              });
              continue;
            }
          }

          // Post-task verification: check diagnostics on all modified files
          if (hasWrittenFiles && !agentSession._verificationDone) {
            agentSession._verificationDone = true;
            try {
              const modifiedFiles = [...new Set(agentSession.filesChanged)] as string[];
              const allErrors: string[] = [];
              for (const relPath of modifiedFiles) {
                const absPath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
                const fileUri = vscode.Uri.file(absPath);
                const diagnostics = await waitForDiagnostics(fileUri, 3000);
                const errors = getErrorDiagnostics(diagnostics);
                if (errors.length > 0) {
                  allErrors.push(`${relPath}:\n${formatDiagnostics(errors)}`);
                }
              }
              if (allErrors.length > 0) {
                messages.push({ role: 'assistant', content: response });
                messages.push({
                  role: 'user',
                  content: `You declared [TASK_COMPLETE] but errors remain in modified files:\n\n${allErrors.join('\n\n')}\n\nFix these errors before completing the task.`
                });
                continue;
              }
            } catch {
              // Non-critical — allow completion if diagnostics fail
            }
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
          consecutiveNoToolIterations++;
          const noToolMsg: any = { role: 'assistant', content: response };
          if (thinkingContent) noToolMsg.thinking = thinkingContent;
          messages.push(noToolMsg);

          // If the model responds with text but no tools for 2+ consecutive
          // iterations, treat it as done — the model has answered and isn't
          // going to use tools. Without this, the loop sends "Continue with
          // the task" forever.
          if (consecutiveNoToolIterations >= 2) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Breaking: ${consecutiveNoToolIterations} consecutive no-tool iterations`);
            break;
          }

          if (iteration < config.maxIterations - 1) {
            messages.push({
              role: 'user',
              content: this.buildContinuationMessage(
                iteration, config.maxIterations, sessionMemory,
                continuationStrategy, agentSession.filesChanged || []
              )
            });
          }
          continue;
        }

        // Tools found — reset the no-tool counter
        consecutiveNoToolIterations = 0;

        // --- 7. Execute tool batch ---
        const groupTitle = getProgressGroupTitle(toolCalls);
        const isTerminalOnly = toolCalls.every(t => t.name === 'run_terminal_command' || t.name === 'run_command');

        // Skip progress group wrapper for terminal-only batches — the approval card is sufficient
        if (!isTerminalOnly) {
          this.emitter.postMessage({ type: 'startProgressGroup', title: groupTitle, sessionId });
          await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });
        }

        // Push assistant message to conversation history
        const assistantMsg: any = { role: 'assistant', content: response };
        if (thinkingContent) assistantMsg.thinking = thinkingContent;
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        const batchResult = await this.toolRunner.executeBatch(
          toolCalls, context, sessionId, model, groupTitle,
          currentCheckpointId, agentSession, useNativeTools, token, messages
        );

        if (batchResult.wroteFiles) {
          hasWrittenFiles = true;
        }

        // Track iteration in session memory
        const iterSummary = AgentSessionMemory.buildIterationSummary(
          iteration,
          toolCalls.map((tc, idx) => {
            const output = (useNativeTools ? (batchResult.nativeResults[idx]?.content ?? '') : (batchResult.xmlResults[idx] ?? ''));
            return {
              name: tc.name,
              args: tc.args,
              output,
              success: !output.startsWith('Error:')
            };
          })
        );
        sessionMemory.addIterationSummary(iterSummary);

        if (!isTerminalOnly) {
          this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
          await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
        }

        // Feed tool results back into conversation history
        if (useNativeTools) {
          messages.push(...batchResult.nativeResults);
        } else if (batchResult.xmlResults.length > 0) {
          const toolResultText = batchResult.xmlResults.join('\n\n');
          messages.push({
            role: 'user',
            content: this.buildContinuationMessage(
              iteration, config.maxIterations, sessionMemory,
              continuationStrategy, agentSession.filesChanged || [],
              toolResultText
            )
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

    // Persist session memory for future reference
    if (sessionMemory.iterationCount > 0 && sessionId) {
      try {
        await this.databaseService.saveSessionMemory(sessionId, sessionMemory.toJSON());
      } catch (err) {
        console.warn('[AgentChatExecutor] Failed to persist session memory:', err);
      }
    }

    const { summary, assistantMessage } = await this.summaryBuilder.finalize(
      sessionId, model, agentSession,
      accumulatedExplanation, hasPersistedIterationText, currentCheckpointId
    );

    return { summary, assistantMessage, checkpointId: currentCheckpointId || undefined };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build a strategy-aware continuation message for the agent loop. */
  private buildContinuationMessage(
    iteration: number,
    maxIterations: number,
    sessionMemory: AgentSessionMemory,
    strategy: ContinuationStrategy,
    filesChanged: string[],
    toolResults?: string
  ): string {
    const remaining = maxIterations - iteration - 1;

    if (strategy === 'minimal') {
      return toolResults
        ? `${toolResults}\n\nContinue. Respond with [TASK_COMPLETE] when done.`
        : 'Continue. Respond with [TASK_COMPLETE] when done.';
    }

    const parts: string[] = [];

    if (toolResults) {
      parts.push(toolResults);
    }

    if (strategy === 'full') {
      // Iteration budget
      parts.push(`[Iteration ${iteration + 1}/${maxIterations} — ${remaining} remaining]`);

      // Files modified so far
      if (filesChanged.length > 0) {
        const uniqueFiles = [...new Set(filesChanged)];
        const fileList = uniqueFiles.length <= 5
          ? uniqueFiles.join(', ')
          : `${uniqueFiles.slice(0, 5).join(', ')} (+${uniqueFiles.length - 5} more)`;
        parts.push(`Files modified: ${fileList}`);
      }

      // Session memory summary
      const memorySummary = sessionMemory.getCompactSummary();
      if (memorySummary) {
        parts.push(`Memory: ${memorySummary}`);
      }
    }

    parts.push('Continue with the task. Use tools or respond with [TASK_COMPLETE] if finished.');
    return parts.join('\n');
  }

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

  /** Expose the prompt builder for use by other executors. */
  get promptBuilderInstance(): AgentPromptBuilder {
    return this.promptBuilder;
  }
}
