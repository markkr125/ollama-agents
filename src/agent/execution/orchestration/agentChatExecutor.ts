import * as fs from 'fs';
import * as vscode from 'vscode';
import { getConfig } from '../../../config/settings';
import { DatabaseService } from '../../../services/database/databaseService';
import { EditManager } from '../../../services/editManager';
import { extractContextLength, getModelCapabilities, ModelCapabilities } from '../../../services/model/modelCompatibility';
import { OllamaClient } from '../../../services/model/ollamaClient';
import { PendingEditDecorationProvider } from '../../../services/review/pendingEditDecorationProvider';
import { TerminalManager } from '../../../services/terminalManager';
import { AgentExecuteParams } from '../../../types/agent';
import { MessageRecord, Session } from '../../../types/session';
import { formatDiagnostics, getErrorDiagnostics, waitForDiagnostics } from '../../../utils/diagnosticWaiter';
import { removeToolCalls } from '../../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../../views/chatTypes';
import { getProgressGroupTitle } from '../../../views/toolUIFormatter';
import { SessionManager } from '../../sessions/sessionManager';
import { ToolRegistry } from '../../toolRegistry';
import { resolveMultiRootPath } from '../../tools/filesystem/pathUtils';
import { AgentEventEmitter } from '../agentEventEmitter';
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
import { AgentFileEditHandler } from '../approval/agentFileEditHandler';
import { AgentTerminalHandler } from '../approval/agentTerminalHandler';
import { ApprovalManager } from '../approval/approvalManager';
import { ConversationHistory } from '../conversationHistory';
import { AgentPromptBuilder } from '../prompts/agentPromptBuilder';
import { AgentContextCompactor } from '../streaming/agentContextCompactor';
import {
  buildLoopContinuationMessage,
  buildToolCallSummary,
  checkNoToolCompletion,
  formatTextToolResults,
  isCompletionSignaled,
  type AgentLoopEvent
} from '../streaming/agentControlPlane';
import { AgentSessionMemory } from '../streaming/agentSessionMemory';
import { AgentStreamProcessor } from '../streaming/agentStreamProcessor';
import { AgentSummaryBuilder } from '../toolExecution/agentSummaryBuilder';
import { AgentToolRunner } from '../toolExecution/agentToolRunner';
import { CheckpointManager } from '../toolExecution/checkpointManager';
import { AgentExploreExecutor } from './agentExploreExecutor';

// ---------------------------------------------------------------------------
// Text similarity helper — trigram-based Jaccard similarity.
// Used to detect when the model restates the same plan across iterations.
// Returns 0.0 (completely different) to 1.0 (identical).
// ---------------------------------------------------------------------------

/** Maximum tool calls allowed per iteration batch. */
const MAX_TOOLS_PER_BATCH = 10;

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

    this.terminalHandler = new AgentTerminalHandler(
      this.toolRegistry,
      this.databaseService,
      this.approvalManager,
      this.outputChannel
    );

    this.fileEditHandler = new AgentFileEditHandler(
      this.toolRegistry,
      this.databaseService,
      this.editManager,
      this.approvalManager,
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
      this.terminalHandler,
      this.fileEditHandler,
      this.checkpointManager,
      this.decorationProvider,
      this.refreshExplorer,
      (checkpointId: string) => this._onFileWritten?.(checkpointId)
    );

    this.summaryBuilder = new AgentSummaryBuilder(this.client, this.databaseService);
  }

  // -------------------------------------------------------------------------
  // Public helpers delegated from chatView
  // -------------------------------------------------------------------------

  handleToolApprovalResponse(approvalId: string, approved: boolean, command?: string): void {
    this.approvalManager.handleResponse(approvalId, approved, command);
  }

  /**
   * Resolve model capabilities for the explorer model.
   * Checks DB cache first, falls back to live /api/show.
   */
  private explorerCapabilitiesCache = new Map<string, ModelCapabilities>();
  private async resolveExplorerCapabilities(explorerModel: string): Promise<ModelCapabilities | undefined> {
    const cached = this.explorerCapabilitiesCache.get(explorerModel);
    if (cached) return cached;

    try {
      // Try DB cache first
      const models = await this.databaseService.getCachedModels();
      const record = models.find(m => m.name === explorerModel);
      if (record) {
        const caps = getModelCapabilities(record);
        this.explorerCapabilitiesCache.set(explorerModel, caps);
        return caps;
      }
    } catch { /* fall through to live detection */ }

    try {
      const showResp = await this.client.showModel(explorerModel);
      const contextLength = extractContextLength(showResp);
      const caps: ModelCapabilities = {
        chat: true,
        fim: false,
        tools: (showResp.capabilities ?? []).includes('tools'),
        vision: (showResp.capabilities ?? []).includes('vision'),
        embedding: false,
        contextLength
      };
      this.explorerCapabilitiesCache.set(explorerModel, caps);
      return caps;
    } catch {
      this.outputChannel.appendLine(`[AgentChatExecutor] Failed to resolve capabilities for explorer model: ${explorerModel}`);
      return undefined;
    }
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

  /**
   * Persist a UI event to the database without posting to the webview.
   * Used by view-layer handlers (fileChangeMessageHandler, chatView) that
   * need to persist events but handle webview posting themselves.
   */
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
      console.warn('[AgentChatExecutor.persistUiEvent] Failed to persist UI event:', error);
    }
  }

  /**
   * Persist + post a git branch creation as a full progress group.
   * Called from chatView.ts so session history matches live chat.
   */
  async persistGitBranchAction(sessionId: string, branchName: string): Promise<void> {
    const events = new AgentEventEmitter(sessionId, this.databaseService, this.emitter);
    const title = 'Git setup';
    await events.emit('startProgressGroup', { title });

    const action = { status: 'success' as const, icon: '📌', text: `Created branch: ${branchName}`, detail: branchName };
    await events.emit('showToolAction', action);

    await events.emit('finishProgressGroup', {});
  }

  // -------------------------------------------------------------------------
  // Main agent execution loop
  // -------------------------------------------------------------------------

  async execute(
    params: AgentExecuteParams
  ): Promise<{ summary: string; assistantMessage: MessageRecord; checkpointId?: string }> {
    const {
      agentSession, config, token, sessionId, model,
      conversationHistory, dispatch
    } = params;
    let capabilities = params.capabilities;
    // Create unified event emitter for this session — guarantees every UI
    // event is both persisted and posted. Bind it to all sub-handlers.
    const events = new AgentEventEmitter(sessionId, this.databaseService, this.emitter);
    this.toolRunner.bindEmitter(events);
    this.summaryBuilder.bindEmitter(events);

    // Extract file paths from user-provided context so sub-agents don't waste
    // iterations searching for files the orchestrator already knows about.
    // The user prompt contains markers like:
    //   "User's selected code from folder/src/Foo.ts:L10-L50 (already provided...)"
    //   "Contents of folder/src/Bar.ts (already provided...)"
    const userContextPaths = extractUserContextPaths(agentSession.task);
    const userContextBlocks = extractUserContextBlocks(agentSession.task);
    const symbolMap = extractSymbolMap(agentSession.task);

    const context = {
      workspace: agentSession.workspace,
      workspaceFolders: vscode.workspace.workspaceFolders,
      token,
      outputChannel: this.outputChannel,
      sessionId,
      terminalManager: this.terminalManager,
      runSubagent: this._exploreExecutor
        ? async (task: string, mode: 'explore' | 'review' | 'deep-explore', contextHint?: string, title?: string, description?: string) => {
            // Use resolved explorer model (3-tier: session → global → agent model)
            const explorerModel = config.explorerModel || model;
            const explorerCaps = explorerModel !== model
              ? await this.resolveExplorerCapabilities(explorerModel)
              : capabilities;
            // Auto-inject user-provided context into sub-agent tasks:
            // 1. Known file paths so they don't waste iterations searching
            // 2. Selected code content so they start with the code in-hand
            // 3. Symbol map so they know where every definition lives
            let enrichedTask = task;
            if (userContextPaths.length > 0) {
              enrichedTask += `\n\nKNOWN FILE PATHS (from user context — use these exact paths, do not guess or search for them):\n${userContextPaths.map(p => `- ${p}`).join('\n')}`;
            }
            if (userContextBlocks) {
              enrichedTask += `\n\n${userContextBlocks}`;
            }
            if (symbolMap) {
              enrichedTask += `\n\n${symbolMap}`;
            }
            this.outputChannel.appendLine(`[runSubagent] Enrichment: paths=${userContextPaths.length}, codeBlocks=${userContextBlocks ? userContextBlocks.length : 0}ch, symbolMap=${symbolMap ? symbolMap.length : 0}ch → task=${enrichedTask.length}ch`);
            // Forward the detected primary workspace so sub-agents know which
            // folder to scope their exploration to (fixes multi-root workspaces).
            return this._exploreExecutor!.executeSubagent(enrichedTask, token, sessionId, explorerModel, mode, explorerCaps, contextHint, title, agentSession.workspace, description);
          }
        : undefined
    };

    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();

    // Resolve context window: capabilities DB > live /api/show > user config > Ollama default
    capabilities = await resolveContextWindow(this.client, model, capabilities, useNativeTools, this.outputChannel, 'AgentChatExecutor');

    const allFolders = vscode.workspace.workspaceFolders || [];

    // Load project context (reads package.json, CLAUDE.md, etc.) before prompt assembly
    await this.promptBuilder.loadProjectContext(agentSession.workspace);

    if (dispatch) {
      this.outputChannel.appendLine(`[AgentChatExecutor] Dispatch: intent=${dispatch.intent}, needsWrite=${dispatch.needsWrite}, confidence=${dispatch.confidence} — ${dispatch.reasoning}`);
    }

    const systemContent = useNativeTools
      ? this.promptBuilder.buildOrchestratorNativePrompt(allFolders, agentSession.workspace, dispatch?.intent)
      : this.promptBuilder.buildOrchestratorXmlPrompt(allFolders, agentSession.workspace, dispatch?.intent);

    // Build typed conversation history — all message additions go through
    // ConversationHistory methods to enforce protocol correctness.
    const history = new ConversationHistory({
      systemPrompt: systemContent,
      conversationHistory: conversationHistory || [],
      userTask: agentSession.task,
      useNativeTools
    });
    const messages = history.messages;

    if (!useNativeTools) {
      events.post('showWarningBanner', {
        message: 'This model doesn\'t natively support tool calling. Agent mode will use text-based tool parsing, which may be less reliable. Consider using a model like llama3.1+, qwen2.5+, or mistral.'
      });
    }

    let iteration = 0;
    let accumulatedExplanation = '';
    let hasWrittenFiles = false;
    let hasPersistedIterationText = false;
    let consecutiveNoToolIterations = 0;
    let lastThinkingContent = '';  // Track across iterations for summary context

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
    sessionMemory.setOriginalTask(agentSession.task);
    const continuationStrategy = getConfig().agent.continuationStrategy || 'full';
    let lastPromptTokens: number | undefined;

    // Token usage reminder thresholds already sent (prevent duplicate injections)
    const tokenReminderSent = new Set<number>();

    // External file modification detection: after each write, record the file's
    // mtime. Before the next iteration's LLM call, check if any have changed
    // (e.g. by formatters, linters, or user edits). Adapted from Claude Code's
    // "file-opened-in-ide" system reminder pattern.
    const fileWriteTimestamps = new Map<string, number>();

    // Duplicate tool call detection: tracks tool call signatures from recent
    // iterations. If the model calls the same tool with the same arguments
    // repeatedly, we inject a warning and skip the duplicates. This prevents
    // models (especially smaller ones) from looping on the same action.
    // Key: "toolName|argsHash", Value: iteration number when last seen.
    const recentToolSignatures = new Map<string, number>();

    // IDE file focus tracking: detect when the user switches files during the
    // agent session and inject a brief note. Helps the model stay aware of
    // user intent without requiring explicit messages.
    let lastActiveEditorPath: string | undefined = vscode.window.activeTextEditor?.document.uri.fsPath;

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      // Diagnostic: log conversation state at each iteration start
      logIterationState(this.outputChannel, '', iteration, messages);

      let phase = 'preparing request';

      try {
        // --- 0. Pre-iteration housekeeping (compaction, stale notes, external files, IDE focus) ---
        const contextWindow = computeEffectiveContextWindow(capabilities);
        if (iteration > 1) {
          const result = await this.prepareIteration({
            iteration, history, messages, contextWindow, model,
            lastPromptTokens, events, sessionMemory, fileWriteTimestamps,
            context, lastActiveEditorPath
          });
          lastActiveEditorPath = result.lastActiveEditorPath;
        }

        // --- 1. Stream LLM response ---
        // Strip thinking from ALL history messages before sending.
        // Per Ollama #10448 / Qwen3 docs: "No Thinking Content in History".
        history.prepareForRequest();

        const { agentMode: modeConfig } = getConfig();
        const toolDefs = useNativeTools ? this.promptBuilder.getOrchestratorToolDefinitions() : undefined;

        const chatRequest = buildChatRequest(
          model, messages, modeConfig, contextWindow, useNativeTools,
          toolDefs, agentConfig.keepAlive
        );

        // --- Diagnostic: log request payload sizes for debugging slow models ---
        logRequestPayload(this.outputChannel, '', iteration, messages, chatRequest);

        // Signal the webview that a new iteration is starting so it can
        // save the existing text block content as a base prefix. Without this,
        // iteration 2's streaming (which starts from '') overwrites iteration 1's
        // text block content due to the replacement semantics of streamChunk.
        if (iteration > 1) {
          events.post('iterationBoundary', {});
        }

        phase = 'streaming response from model';
        const thinkingStartTime = Date.now();
        const streamResult = await this.streamProcessor.streamIteration(
            chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime,
            this.toolRegistry.getToolNames()
          );

        let { response } = streamResult;
        const { thinkingContent, nativeToolCalls, truncated, toolParseErrors } = streamResult;

        // Track last thinking for summary builder enrichment
        if (thinkingContent.trim()) {
          lastThinkingContent = thinkingContent;
        }

        // --- Recover from Ollama tool-parse errors (smart/curly quotes) ---
        // Must happen BEFORE text processing — otherwise the error text leaks
        // into the UI as regular assistant chat text.
        const recoveredToolCalls: Array<{ name: string; args: any }> = [];
        if (toolParseErrors.length > 0 && useNativeTools) {
          this.outputChannel.appendLine(`[Iteration ${iteration}] Ollama tool-parse error(s) detected — attempting recovery`);
          for (const errText of toolParseErrors) {
            const recovered = recoverToolCallFromError(errText, nativeToolCalls, this.outputChannel, '', iteration);
            if (recovered) {
              recoveredToolCalls.push(recovered);
            }
          }
        }

        // Update real token counts for context compactor (used next iteration)
        const tokenResult = trackPromptTokens(
          messages, streamResult.promptTokens, streamResult.completionTokens,
          contextWindow, this.outputChannel, '', iteration
        );
        if (tokenResult.lastPromptTokens != null) {
          lastPromptTokens = tokenResult.lastPromptTokens;
        }

        // Emit token usage to the webview for the live indicator
        const toolDefCount = useNativeTools ? this.promptBuilder.getOrchestratorToolDefinitions().length : 0;
        await emitTokenUsage(events, messages, toolDefCount, lastPromptTokens, streamResult.completionTokens, contextWindow);

        // Token usage system reminder: when context usage exceeds key thresholds,
        // inject a brief note so the model knows to be concise. Adapted
        // from Claude Code's system-reminder-token-usage pattern.
        // Only inject ONCE per threshold to avoid polluting conversation history.
        if (lastPromptTokens && contextWindow) {
          const usagePct = Math.round((lastPromptTokens / contextWindow) * 100);
          const threshold = usagePct >= 85 ? 85 : usagePct >= 70 ? 70 : 0;
          if (threshold > 0 && !tokenReminderSent.has(threshold)) {
            tokenReminderSent.add(threshold);
            const remainingPct = 100 - usagePct;
            this.outputChannel.appendLine(`[Iteration ${iteration}] Context usage: ${usagePct}% (${lastPromptTokens}/${contextWindow}) — injecting token reminder (threshold ${threshold}%)`);
            history.addSystemNote(`Context usage: ~${usagePct}% (${remainingPct}% remaining). Be concise to preserve remaining context. Focus on completing the task efficiently.`);
          }
        }

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          // Persist any accumulated thinking content before breaking so it
          // survives session restore.
          await persistCancellationThinking(events, thinkingContent, thinkingStartTime, streamResult.lastThinkingTimestamp, streamResult.thinkingCollapsed);
          break;
        }

        // Handle output truncation — the model hit the context/token limit mid-response.
        // Push a continuation message so it can resume from where it was cut off.
        if (truncated && response) {
          this.outputChannel.appendLine(`[Iteration ${iteration}] Output truncated by context limit — requesting continuation`);
          // NO THINKING IN HISTORY: Per Ollama issue #10448 and Qwen3 docs,
          // historical model output should only include the final output part.
          // Including `thinking` causes models to see previous reasoning and
          // repeat the same plan across iterations.
          // The '[Reasoning completed]' marker prevents blank-turn amnesia for
          // templates that only render {{ .Content }}.
          history.addAssistantMessage(response, thinkingContent);
          history.addContinuation('Your response was truncated due to the output length limit. Break your work into smaller pieces. Continue EXACTLY where you left off — do not repeat what you already said. If you were in the middle of a tool call, re-emit the complete tool call.');
          continue;
        }

        // --- 2. Log iteration response ---
        this.logIterationResponse(iteration, response, thinkingContent, nativeToolCalls);

        // De-duplicate: some models echo thinking content in response too
        response = deduplicateThinkingEcho(response, thinkingContent);

        // --- 3. Persist thinking block (BEFORE text and tools — order matters for history) ---
        await persistThinkingBlock(events, thinkingContent, thinkingStartTime, streamResult.lastThinkingTimestamp, streamResult.thinkingCollapsed);

        // --- 4. Process per-iteration delta text ---
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').replace(/\[END_OF_EXPLORATION\]/gi, '').trim();

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
        // Thinking models may signal completion only in thinking content (empty response).
        if (isCompletionSignaled(response, thinkingContent)) {
          const gate = await this.checkCompletionGates(
            response, thinkingContent, history, agentSession, context,
            taskRequiresWrite, taskRequiresTerminal, hasWrittenFiles
          );
          if (gate === 'continue') continue;

          const completionText = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').replace(/\[END_OF_EXPLORATION\]/gi, '').trim();
          accumulatedExplanation = completionText || accumulatedExplanation;

          if (completionText && sessionId) {
            await this.databaseService.addMessage(sessionId, 'assistant', completionText, { model });
            hasPersistedIterationText = true;
          }
          break;
        }

        // --- 6. Extract tool calls ---
        phase = 'parsing tool calls';
        let toolCalls = parseToolCalls(response, nativeToolCalls, useNativeTools, this.toolRegistry.getToolNames());

        // Merge in any tool calls recovered from Ollama parse errors
        if (toolCalls.length === 0 && recoveredToolCalls.length > 0) {
          toolCalls = recoveredToolCalls;
          this.outputChannel.appendLine(`[Iteration ${iteration}] Using ${recoveredToolCalls.length} recovered tool call(s)`);
        }

        this.outputChannel.appendLine(`[Iteration ${iteration}] Parsed ${toolCalls.length} tool calls (${useNativeTools ? 'native' : 'XML'}):`);
        toolCalls.forEach((tc, i) => this.outputChannel.appendLine(`  [${i}] ${tc.name}: ${JSON.stringify(tc.args)}`));
        this.outputChannel.appendLine('---');

        // --- 6a. Deduplicate tool calls ---
        if (toolCalls.length > 0) {
          const { filtered, allDuplicated } = this.deduplicateToolCalls(
            toolCalls, recentToolSignatures, iteration
          );
          toolCalls = filtered;

          if (allDuplicated) {
            history.addAssistantMessage(response, thinkingContent);
            history.addContinuation('You are repeating the same tool calls you already made. The results have not changed. Please use different tools or arguments, or if you have enough information, respond with [TASK_COMPLETE].');
            consecutiveNoToolIterations++;
            continue;
          }
        }

        if (toolCalls.length === 0) {
          consecutiveNoToolIterations++;
          history.addAssistantMessage(response, thinkingContent);

          // Smart completion detection (pure function — see agentControlPlane.ts)
          const completionAction = checkNoToolCompletion({
            response, thinkingContent, hasWrittenFiles, consecutiveNoToolIterations
          });

          if (completionAction === 'break_implicit') {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Breaking: empty response after writing files — implicit completion`);
            break;
          }
          if (completionAction === 'break_consecutive') {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Breaking: ${consecutiveNoToolIterations} consecutive no-tool iterations`);
            break;
          }

          if (iteration < config.maxIterations - 1) {
            // Directive probe: tell the model explicitly what to do next
            const probeContent = hasWrittenFiles
              ? 'If you are done, respond with [TASK_COMPLETE]. Otherwise, continue using tools.'
              : buildLoopContinuationMessage(
                  { iteration, maxIterations: config.maxIterations, strategy: continuationStrategy, filesChanged: agentSession.filesChanged },
                  { event: 'no_tools' as AgentLoopEvent }
                );
            history.addContinuation(probeContent);
          }
          continue;
        }

        // Tools found — reset the no-tool counter
        consecutiveNoToolIterations = 0;

        // --- 7. Execute tool batch ---
        const groupTitle = getProgressGroupTitle(toolCalls);
        const isTerminalOnly = toolCalls.every(t => t.name === 'run_terminal_command' || t.name === 'run_command');
        const isSubagentOnly = toolCalls.every(t => t.name === 'run_subagent');

        // Skip progress group wrapper for terminal-only batches (approval card is sufficient)
        // and subagent-only batches (sub-agent creates its own dedicated wrapper group)
        if (!isTerminalOnly && !isSubagentOnly) {
          await events.emit('startProgressGroup', { title: groupTitle });
        }

        // Build assistant message for conversation history and persist to DB.
        const toolSummary = buildToolCallSummary(toolCalls);
        await buildAndPersistAssistantToolMessage(
          toolCalls, nativeToolCalls, response, thinkingContent,
          useNativeTools, messages, sessionId, this.databaseService,
          hasPersistedIterationText, model, toolSummary, history
        );

        const toolNames = toolCalls.map(tc => tc.name).join(', ');
        phase = `executing tools: ${toolNames}`;
        const batchResult = await this.toolRunner.executeBatch({
          toolCalls, context, sessionId, model, groupTitle,
          currentCheckpointId, agentSession, useNativeTools, token, messages
        });

        if (batchResult.wroteFiles) {
          hasWrittenFiles = true;

          // Record file mtimes after writes for external modification detection
          const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
          for (const relPath of uniqueFiles) {
            try {
              const absPath = resolveMultiRootPath(relPath, context.workspace!, context.workspaceFolders);
              const stat = fs.statSync(absPath);
              fileWriteTimestamps.set(relPath, stat.mtimeMs);
            } catch { /* ignore */ }
          }
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

        if (!isTerminalOnly && !isSubagentOnly) {
          await events.emit('finishProgressGroup', {});
        }

        // Show a "Working..." spinner immediately after tools complete.
        // Covers the gap between finishProgressGroup and the next iteration's
        // streamIteration() → showThinking (model loading + first chunk delay).
        events.post('showThinking', { message: 'Working...' });

        // Feed tool results back into conversation history.
        this.feedToolResultsToHistory({
          history, batchResult, useNativeTools, iteration, config,
          continuationStrategy, agentSession, sessionMemory
        });

      } catch (error: any) {
        await buildAndEmitFatalError(events, error, model, phase, iteration, config.maxIterations, this.outputChannel, 'AgentChatExecutor', messages);
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
      accumulatedExplanation, hasPersistedIterationText, currentCheckpointId,
      lastThinkingContent
    );

    return { summary, assistantMessage, checkpointId: currentCheckpointId || undefined };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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

  /**
   * Pre-iteration housekeeping: compact conversation history, clean stale
   * system notes, detect external file modifications, and track IDE focus.
   * Called at the start of each iteration (after the first).
   */
  private async prepareIteration(opts: {
    iteration: number;
    history: ConversationHistory;
    messages: any[];
    contextWindow: number;
    model: string;
    lastPromptTokens: number | undefined;
    events: AgentEventEmitter;
    sessionMemory: AgentSessionMemory;
    fileWriteTimestamps: Map<string, number>;
    context: { workspace: any; workspaceFolders: any };
    lastActiveEditorPath: string | undefined;
  }): Promise<{ lastActiveEditorPath: string | undefined }> {
    const {
      iteration, history, messages, contextWindow, model,
      lastPromptTokens, events, sessionMemory, fileWriteTimestamps, context
    } = opts;
    let { lastActiveEditorPath } = opts;

    // Inject session memory reminder into system prompt before compaction
    const memoryReminder = sessionMemory.toSystemReminder();
    if (memoryReminder) {
      history.updateSystemPrompt(content =>
        content.replace(/<session_memory>[\s\S]*?<\/session_memory>/g, '').trimEnd() + '\n\n' + memoryReminder
      );
    }

    await compactAndEmit(this.contextCompactor, messages, contextWindow, model, lastPromptTokens, events, this.outputChannel, '', iteration);

    // Clean stale system notes from previous iterations
    history.cleanStaleSystemNotes();

    // External file modification detection
    if (fileWriteTimestamps.size > 0) {
      const externallyModified: string[] = [];
      for (const [relPath, lastMtime] of fileWriteTimestamps) {
        try {
          const absPath = resolveMultiRootPath(relPath, context.workspace!, context.workspaceFolders);
          const stat = fs.statSync(absPath);
          if (stat.mtimeMs > lastMtime + 100) {
            externallyModified.push(relPath);
            fileWriteTimestamps.set(relPath, stat.mtimeMs);
          }
        } catch { /* file deleted or inaccessible */ }
      }
      if (externallyModified.length > 0) {
        const fileList = externallyModified.join(', ');
        this.outputChannel.appendLine(`[Iteration ${iteration}] External modifications detected: ${fileList}`);
        history.addSystemNote(`The following file(s) were modified externally (e.g. by a formatter, linter, or user edit) since you last wrote them: ${fileList}. Re-read them if you need the latest content before making further changes. Do NOT revert external formatting changes.`);
      }
    }

    // IDE file focus tracking
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      const currentPath = activeEditor.document.uri.fsPath;
      if (currentPath !== lastActiveEditorPath) {
        const inWorkspace = (vscode.workspace.workspaceFolders || []).some(
          wf => currentPath.startsWith(wf.uri.fsPath)
        );
        if (inWorkspace && lastActiveEditorPath) {
          const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
          this.outputChannel.appendLine(`[Iteration ${iteration}] User opened ${relPath} in editor`);
          history.addSystemNote(`The user opened ${relPath} in the editor. This may or may not be related to the current task.`);
        }
        lastActiveEditorPath = currentPath;
      }
    }

    return { lastActiveEditorPath };
  }

  /**
   * Feed tool execution results back into conversation history. Native mode
   * uses proper `role:'tool'` messages; XML mode wraps results in a
   * continuation message with a control packet.
   */
  private feedToolResultsToHistory(opts: {
    history: ConversationHistory;
    batchResult: import('../toolExecution/agentToolRunner').ToolBatchResult;
    useNativeTools: boolean;
    iteration: number;
    config: { maxIterations: number };
    continuationStrategy: 'full' | 'standard' | 'minimal';
    agentSession: Session;
    sessionMemory: AgentSessionMemory;
  }): void {
    const { history, batchResult, useNativeTools, iteration, config, continuationStrategy, agentSession, sessionMemory } = opts;

    if (useNativeTools) {
      history.addNativeToolResults(batchResult.nativeResults);
      history.addContinuation(buildLoopContinuationMessage(
        { iteration, maxIterations: config.maxIterations, strategy: continuationStrategy, filesChanged: agentSession.filesChanged },
        { event: 'tool_results' as AgentLoopEvent, note: sessionMemory.getCompactSummary() || undefined }
      ));
    } else if (batchResult.xmlResults.length > 0) {
      const toolResultText = formatTextToolResults(batchResult.xmlResults);
      history.addContinuation(buildLoopContinuationMessage(
        { iteration, maxIterations: config.maxIterations, strategy: continuationStrategy, filesChanged: agentSession.filesChanged },
        { event: 'tool_results' as AgentLoopEvent, toolResults: toolResultText, note: sessionMemory.getCompactSummary() || undefined }
      ));
    }
  }

  /**
   * Post-[TASK_COMPLETE] verification gates. Checks whether the model's
   * completion signal should be accepted or rejected.
   *
   * Returns `'continue'` if a gate triggered (history already updated with
   * feedback), or `null` if completion is approved.
   */
  private async checkCompletionGates(
    response: string,
    thinkingContent: string,
    history: ConversationHistory,
    agentSession: Session,
    context: { workspace: any; workspaceFolders: any },
    taskRequiresWrite: boolean,
    taskRequiresTerminal: boolean,
    hasWrittenFiles: boolean
  ): Promise<'continue' | null> {
    // Gate 1: task requires file writes but none were made
    if (taskRequiresWrite && !hasWrittenFiles) {
      history.addAssistantMessage(response, thinkingContent);
      history.addContinuation(
        'You indicated the task is complete, but NO files have been modified. Reading a file does NOT change it. ' +
        'You MUST call write_file with the modified content to actually make changes. If no changes are truly needed, explain why explicitly.'
      );
      return 'continue';
    }

    // Gate 2: task requires terminal command but none was run (one-time nudge)
    if (taskRequiresTerminal && !hasWrittenFiles &&
        !(agentSession.toolCalls || []).some((tc: any) => tc.tool === 'run_terminal_command' || tc.name === 'run_terminal_command')) {
      if (!agentSession._terminalNudgeSent) {
        agentSession._terminalNudgeSent = true;
        history.addAssistantMessage(response, thinkingContent);
        history.addContinuation(
          'You indicated the task is complete, but no terminal command was executed. ' +
          'If the task requires running a command (test, build, install, etc.), use run_terminal_command. ' +
          'If no command is needed, explain why and respond with [TASK_COMPLETE].'
        );
        return 'continue';
      }
    }

    // Gate 3: post-task diagnostics verification (one-time)
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
          history.addAssistantMessage(response, thinkingContent);
          history.addContinuation(
            `You declared [TASK_COMPLETE] but errors remain in modified files:\n\n${allErrors.join('\n\n')}\n\nFix these errors before completing the task.`
          );
          return 'continue';
        }
      } catch {
        // Non-critical — allow completion if diagnostics fail
      }
    }

    return null;
  }

  /**
   * Deduplicate tool calls — removes intra-batch duplicates (same tool + args
   * in one batch) and cross-iteration duplicates (same call within last 2
   * iterations). Also caps batch size to `MAX_TOOLS_PER_BATCH`.
   *
   * Updates `recentSignatures` in place for cross-iteration tracking.
   */
  private deduplicateToolCalls(
    toolCalls: Array<{ name: string; args: any }>,
    recentSignatures: Map<string, number>,
    iteration: number
  ): { filtered: Array<{ name: string; args: any }>; allDuplicated: boolean } {
    const seenInBatch = new Set<string>();
    const originalCount = toolCalls.length;
    const dedupedWarnings: string[] = [];

    let filtered = toolCalls.filter(tc => {
      const argsSorted = Object.keys(tc.args || {}).sort()
        .map(k => `${k}=${JSON.stringify(tc.args[k])}`).join('&');
      const sig = `${tc.name}|${argsSorted}`;

      // Intra-batch duplicate
      if (seenInBatch.has(sig)) {
        dedupedWarnings.push(`${tc.name} (intra-batch duplicate)`);
        return false;
      }
      seenInBatch.add(sig);

      // Cross-iteration duplicate (seen in last 2 iterations)
      const lastSeen = recentSignatures.get(sig);
      if (lastSeen !== undefined && iteration - lastSeen <= 2) {
        dedupedWarnings.push(`${tc.name} (repeated from iteration ${lastSeen})`);
        return false;
      }

      return true;
    });

    if (dedupedWarnings.length > 0) {
      this.outputChannel.appendLine(
        `[Iteration ${iteration}] Removed ${dedupedWarnings.length} duplicate tool call(s): ${dedupedWarnings.join(', ')}`
      );
    }

    // Register surviving calls in the signature map
    for (const tc of filtered) {
      const argsSorted = Object.keys(tc.args || {}).sort()
        .map(k => `${k}=${JSON.stringify(tc.args[k])}`).join('&');
      recentSignatures.set(`${tc.name}|${argsSorted}`, iteration);
    }

    // Expire old signatures (older than 3 iterations)
    for (const [sig, iter] of recentSignatures) {
      if (iteration - iter > 3) recentSignatures.delete(sig);
    }

    // Cap batch size
    if (filtered.length > MAX_TOOLS_PER_BATCH) {
      this.outputChannel.appendLine(`[Iteration ${iteration}] Capping tool calls from ${filtered.length} to ${MAX_TOOLS_PER_BATCH}`);
      filtered = filtered.slice(0, MAX_TOOLS_PER_BATCH);
    }

    return { filtered, allDuplicated: filtered.length === 0 && originalCount > 0 };
  }

  /** Expose the prompt builder for use by other executors. */
  get promptBuilderInstance(): AgentPromptBuilder {
    return this.promptBuilder;
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract file paths from user-provided context markers.
// The chatMessageHandler formats attached files/selections as:
//   "User's selected code from folder/src/Foo.ts:L10-L50 (already provided — do not re-read):"
//   "Contents of folder/src/Bar.ts (already provided — do not re-read):"
// We extract these paths so sub-agents receive them automatically and don't
// waste iterations guessing wrong paths or searching.
// ---------------------------------------------------------------------------

export function extractUserContextPaths(prompt: string): string[] {
  const paths: string[] = [];
  const regex = /(?:User's selected code from|Contents of)\s+(\S+?)(?:\s*\(already provided)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    // Strip trailing :L118-L271 line range suffix if present
    const cleaned = match[1].replace(/:L\d+(?:-L?\d+)?$/, '');
    if (cleaned && !paths.includes(cleaned)) {
      paths.push(cleaned);
    }
  }
  return paths;
}

/**
 * Extract user-provided code blocks from the prompt so sub-agents receive
 * the selected code content directly without needing to call read_file.
 * Captures text between "User's selected code from..." markers including
 * the code fence. No size cap — the orchestrator's context compaction
 * handles overflow gracefully.
 */
export function extractUserContextBlocks(prompt: string): string {
  const blocks: string[] = [];
  // Match code blocks labeled with "User's selected code from" or "Contents of"
  const blockRegex = /((?:User's selected code from|Contents of)\s+\S+?\s*\(already provided[^)]*\):\s*\n```[\s\S]*?```)/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(prompt)) !== null) {
    blocks.push(match[1]);
  }
  return blocks.length > 0
    ? `USER CODE (provided — do not re-read these files):\n${blocks.join('\n\n')}`
    : '';
}

/**
 * Extract the SYMBOL MAP block from the prompt so sub-agents receive
 * pre-resolved definition locations without needing to call find_definition.
 */
export function extractSymbolMap(prompt: string): string {
  const match = prompt.match(/(SYMBOL MAP \(pre-resolved via language server[^)]*\):\n(?:- .+\n?)+)/);
  return match ? match[1].trim() : '';
}
