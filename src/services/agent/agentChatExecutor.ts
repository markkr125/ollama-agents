import * as fs from 'fs';
import * as vscode from 'vscode';
import { SessionManager } from '../../agent/sessionManager';
import { ToolRegistry } from '../../agent/toolRegistry';
import { resolveMultiRootPath } from '../../agent/tools/pathUtils';
import { getConfig } from '../../config/settings';
import { DispatchResult, ExecutorConfig } from '../../types/agent';
import { ChatRequest } from '../../types/ollama';
import { MessageRecord } from '../../types/session';
import { formatDiagnostics, getErrorDiagnostics, waitForDiagnostics } from '../../utils/diagnosticWaiter';
import { extractToolCalls, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getProgressGroupTitle } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { extractContextLength, getModelCapabilities, ModelCapabilities } from '../model/modelCompatibility';
import { OllamaClient } from '../model/ollamaClient';
import { PendingEditDecorationProvider } from '../pendingEditDecorationProvider';
import { TerminalManager } from '../terminalManager';
import { AgentContextCompactor, estimateTokensByCategory } from './agentContextCompactor';
import {
  buildLoopContinuationMessage,
  buildToolCallSummary,
  checkNoToolCompletion,
  computeDynamicNumCtx,
  formatTextToolResults,
  isCompletionSignaled,
  type AgentLoopEvent
} from './agentControlPlane';
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
// Text similarity helper — trigram-based Jaccard similarity.
// Used to detect when the model restates the same plan across iterations.
// Returns 0.0 (completely different) to 1.0 (identical).
// ---------------------------------------------------------------------------

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
    conversationHistory?: MessageRecord[],
    dispatch?: DispatchResult
  ): Promise<{ summary: string; assistantMessage: MessageRecord; checkpointId?: string }> {
    const context = {
      workspace: agentSession.workspace,
      workspaceFolders: vscode.workspace.workspaceFolders,
      token,
      outputChannel: this.outputChannel,
      sessionId,
      terminalManager: this.terminalManager,
      runSubagent: this._exploreExecutor
        ? async (task: string, mode: 'explore' | 'review' | 'deep-explore', contextHint?: string, title?: string) => {
            // Use resolved explorer model (3-tier: session → global → agent model)
            const explorerModel = config.explorerModel || model;
            const explorerCaps = explorerModel !== model
              ? await this.resolveExplorerCapabilities(explorerModel)
              : capabilities;
            return this._exploreExecutor!.executeSubagent(task, token, sessionId, explorerModel, mode, explorerCaps, contextHint, title);
          }
        : undefined
    };

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
          this.outputChannel.appendLine(`[AgentChatExecutor] Live /api/show detected context_length=${detected} for ${model}`);
        }
      } catch {
        this.outputChannel.appendLine(`[AgentChatExecutor] Live /api/show failed for ${model} — using config default num_ctx`);
      }
    }

    const allFolders = vscode.workspace.workspaceFolders || [];

    // Load project context (reads package.json, CLAUDE.md, etc.) before prompt assembly
    await this.promptBuilder.loadProjectContext(agentSession.workspace);

    if (dispatch) {
      this.outputChannel.appendLine(`[AgentChatExecutor] Dispatch: intent=${dispatch.intent}, needsWrite=${dispatch.needsWrite}, confidence=${dispatch.confidence} — ${dispatch.reasoning}`);
    }

    const systemContent = useNativeTools
      ? this.promptBuilder.buildOrchestratorNativePrompt(allFolders, agentSession.workspace, dispatch?.intent)
      : this.promptBuilder.buildOrchestratorXmlPrompt(allFolders, agentSession.workspace, dispatch?.intent);

    // Build messages array with conversation history for multi-turn context.
    // For native tool-calling models, preserve role:'tool' messages with tool_name
    // so the model gets proper tool-result association via its template renderer.
    // For XML fallback models, convert role:'tool' → role:'user' with tool name in
    // content (these models have no template support for the tool role).
    const historyMessages = (conversationHistory || [])
      .filter(m => {
        if (m.tool_name === '__ui__') return false;
        if (m.role === 'tool') return !!m.content.trim();
        if (m.role === 'user' || m.role === 'assistant') return !!m.content.trim() || !!m.tool_calls;
        return false;
      })
      .map(m => {
        if (m.role === 'tool') {
          if (useNativeTools) {
            // Native mode: keep role:'tool' with tool_name — the model's template
            // renderer handles this correctly (see Ollama Go renderers).
            return { role: 'tool' as const, content: m.content, tool_name: m.tool_name || 'unknown' };
          }
          // XML fallback: wrap in role:'user' since there's no tool role support.
          const toolName = m.tool_name || 'unknown';
          return { role: 'user' as const, content: `[${toolName} result]\n${m.content}` };
        }
        const msg: any = { role: m.role as 'user' | 'assistant', content: m.content };
        if (m.role === 'assistant' && m.tool_calls) {
          try {
            const parsed = JSON.parse(m.tool_calls);
            if (useNativeTools) {
              // Native mode: attach structured tool_calls — no need to describe in content.
              msg.tool_calls = parsed;
            } else {
              // XML fallback: describe calls in content (model can't see tool_calls field).
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
    const MAX_TOOLS_PER_BATCH = 10;

    // IDE file focus tracking: detect when the user switches files during the
    // agent session and inject a brief note. Helps the model stay aware of
    // user intent without requiring explicit messages.
    let lastActiveEditorPath: string | undefined = vscode.window.activeTextEditor?.document.uri.fsPath;

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      // Diagnostic: log conversation state at each iteration start
      const totalContentChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      const roleCounts = messages.reduce((acc: Record<string, number>, m) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
      }, {});
      const roleBreakdown = Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(', ');
      this.outputChannel.appendLine(`[Iteration ${iteration}] Messages: ${messages.length} (${roleBreakdown}) — ~${Math.round(totalContentChars / 4)} est. tokens`);

      // DIAGNOSTIC: Dump full messages array structure so we can verify
      // tool results are actually being accumulated across iterations
      for (let mi = 0; mi < messages.length; mi++) {
        const m = messages[mi];
        const contentPreview = (m.content || '').substring(0, 120).replace(/\n/g, '\\n');
        const toolCallsInfo = m.tool_calls ? ` tool_calls:[${Array.isArray(m.tool_calls) ? m.tool_calls.length : '?'}]` : '';
        const toolNameInfo = (m as any).tool_name ? ` tool_name:${(m as any).tool_name}` : '';
        this.outputChannel.appendLine(`  [msg ${mi}] role=${m.role}${toolNameInfo}${toolCallsInfo} content(${(m.content || '').length})="${contentPreview}"`);
      }

      let phase = 'preparing request';

      try {
        // --- 0. Compact conversation history if approaching context limit ---
        // contextWindow: the model's EFFECTIVE context limit — used for compaction decisions.
        // numCtx: the DYNAMIC value sent as num_ctx to Ollama — sized to the actual payload
        // so Ollama doesn't pre-allocate a massive KV cache (e.g. 393K for a 6K prompt).
        const detectedContextWindow = capabilities?.contextLength;
        const userContextWindow = getConfig().contextWindow || 16000;
        const rawContextWindow = detectedContextWindow || userContextWindow;
        // Two-tier cap: per-model override → global setting (default 64K)
        const globalCap = getConfig().agent.maxContextWindow;
        const effectiveCap = capabilities?.maxContext ?? globalCap;
        const contextWindow = Math.min(rawContextWindow, effectiveCap);
        if (iteration > 1) {
          // Inject session memory reminder into system prompt before compaction
          const memoryReminder = sessionMemory.toSystemReminder();
          if (memoryReminder && messages.length > 0 && messages[0].role === 'system') {
            // Strip any previous memory block and append fresh one
            const sysContent = messages[0].content.replace(/<session_memory>[\s\S]*?<\/session_memory>/g, '').trimEnd();
            messages[0].content = sysContent + '\n\n' + memoryReminder;
          }

          const compacted = await this.contextCompactor.compactIfNeeded(messages, contextWindow, model, lastPromptTokens);
          if (compacted) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Context compacted — ${compacted.summarizedMessages} messages summarized (${compacted.tokensBefore}→${compacted.tokensAfter} tokens).`);
            // Show visible indicator in the chat UI
            const savedTokens = compacted.tokensBefore - compacted.tokensAfter;
            const savedK = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}K` : String(savedTokens);
            await this.persistUiEvent(sessionId, 'startProgressGroup', { title: 'Summarizing conversation' });
            this.emitter.postMessage({ type: 'startProgressGroup', title: 'Summarizing conversation', sessionId });
            const action = { status: 'success' as const, icon: '📝', text: `Condensed ${compacted.summarizedMessages} messages — freed ~${savedK} tokens`, detail: `${compacted.tokensBefore} → ${compacted.tokensAfter} tokens` };
            await this.persistUiEvent(sessionId, 'showToolAction', action);
            this.emitter.postMessage({ type: 'showToolAction', ...action, sessionId });
            await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
            this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
          }
        }

        // --- 0a. Clean stale system notes from previous iterations ---
        // [SYSTEM NOTE: ...] messages are ephemeral signals (external mods, IDE focus,
        // token warnings). They should only be relevant for the iteration they were
        // injected in. Leaving them accumulates stale context and wastes tokens.
        if (iteration > 1) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user' && typeof messages[i].content === 'string' && messages[i].content.startsWith('[SYSTEM NOTE:')) {
              messages.splice(i, 1);
            }
          }
        }

        // --- 0b. External file modification detection ---
        // Check if any files the agent previously wrote have been modified
        // externally (e.g. by a formatter, linter, or user edit).
        if (iteration > 1 && fileWriteTimestamps.size > 0) {
          const externallyModified: string[] = [];
          for (const [relPath, lastMtime] of fileWriteTimestamps) {
            try {
              const absPath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
              const stat = fs.statSync(absPath);
              if (stat.mtimeMs > lastMtime + 100) { // 100ms grace for async FS flush
                externallyModified.push(relPath);
                fileWriteTimestamps.set(relPath, stat.mtimeMs);
              }
            } catch { /* file deleted or inaccessible */ }
          }
          if (externallyModified.length > 0) {
            const fileList = externallyModified.join(', ');
            this.outputChannel.appendLine(`[Iteration ${iteration}] External modifications detected: ${fileList}`);
            messages.push({
              role: 'user',
              content: `[SYSTEM NOTE: The following file(s) were modified externally (e.g. by a formatter, linter, or user edit) since you last wrote them: ${fileList}. Re-read them if you need the latest content before making further changes. Do NOT revert external formatting changes.]`
            });
          }
        }

        // --- 0c. IDE file focus tracking ---
        // Detect when the user switches to a different file in the editor
        // during the agent session. Gives the model awareness of user intent.
        {
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            const currentPath = activeEditor.document.uri.fsPath;
            if (currentPath !== lastActiveEditorPath) {
              // Only report files within the workspace
              const inWorkspace = (vscode.workspace.workspaceFolders || []).some(
                wf => currentPath.startsWith(wf.uri.fsPath)
              );
              if (inWorkspace && lastActiveEditorPath) {
                const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
                this.outputChannel.appendLine(`[Iteration ${iteration}] User opened ${relPath} in editor`);
                messages.push({
                  role: 'user',
                  content: `[SYSTEM NOTE: The user opened ${relPath} in the editor. This may or may not be related to the current task.]`
                });
              }
              lastActiveEditorPath = currentPath;
            }
          }
        }

        // --- 1. Stream LLM response ---
        // DEFENSIVE: Strip thinking from ALL history messages before sending.
        // Per Ollama #10448 / Qwen3 docs: "No Thinking Content in History".
        // Thinking in previous turns causes models to re-derive the same plan.
        for (const msg of messages) {
          if ('thinking' in msg) {
            delete (msg as any).thinking;
          }
        }

        const { agentMode: modeConfig } = getConfig();

        // Estimate payload tokens for dynamic num_ctx sizing
        const payloadChars = messages.reduce((s: number, m: any) => s + (m.content?.length || 0), 0);
        const toolDefCharsForCtx = useNativeTools ? JSON.stringify(this.promptBuilder.getOrchestratorToolDefinitions()).length : 0;
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
          chatRequest.tools = this.promptBuilder.getOrchestratorToolDefinitions();
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
            `[Iteration ${iteration}] Request payload: system_prompt=${sysEstTokens}tok(${sysChars}ch), ` +
            `tool_defs=${toolDefEstTokens}tok(${toolDefChars}ch, ${toolDefCount} tools), ` +
            `total_messages=${totalEstTokens}tok(${totalChars}ch), ` +
            `num_ctx=${numCtx} (dynamic, model_max=${contextWindow}), num_predict=${modeConfig.maxTokens}, temp=${modeConfig.temperature}`
          );
          // On first iteration, dump the full system prompt so users can review it
          if (iteration === 1) {
            this.outputChannel.appendLine(`[Iteration 1] === SYSTEM PROMPT START ===`);
            this.outputChannel.appendLine(sysMsg);
            this.outputChannel.appendLine(`[Iteration 1] === SYSTEM PROMPT END (${sysChars} chars, ~${sysEstTokens} tokens) ===`);
          }
        }

        // Signal the webview that a new iteration is starting so it can
        // save the existing text block content as a base prefix. Without this,
        // iteration 2's streaming (which starts from '') overwrites iteration 1's
        // text block content due to the replacement semantics of streamChunk.
        if (iteration > 1) {
          this.emitter.postMessage({ type: 'iterationBoundary', sessionId });
        }

        phase = 'streaming response from model';
        const thinkingStartTime = Date.now();
        const streamResult = await this.streamProcessor.streamIteration(
            chatRequest, sessionId, model, iteration, useNativeTools, token, thinkingStartTime,
            useNativeTools ? undefined : this.toolRegistry.getToolNames()
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
        let recoveredToolCalls: Array<{ name: string; args: any }> = [];
        if (toolParseErrors.length > 0 && useNativeTools) {
          this.outputChannel.appendLine(`[Iteration ${iteration}] Ollama tool-parse error(s) detected — attempting recovery`);
          for (const errText of toolParseErrors) {
            const recovered = this.recoverToolCallFromError(errText, nativeToolCalls, iteration);
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
          this.outputChannel.appendLine(`[Iteration ${iteration}] Token usage: prompt=${actualPrompt}, completion=${streamResult.completionTokens ?? '?'}, context_window=${contextWindow}, sent_est=${sentEstTokens}, sent_msgs=${sentMsgCount}, ratio=${ratio.toFixed(2)}${truncationWarning}`);
        }

        // Emit token usage to the webview for the live indicator
        const toolDefCount = useNativeTools ? this.promptBuilder.getOrchestratorToolDefinitions().length : 0;
        const categories = estimateTokensByCategory(messages, toolDefCount, lastPromptTokens);
        const tokenPayload = {
          promptTokens: lastPromptTokens ?? categories.total,
          completionTokens: streamResult.completionTokens,
          contextWindow,
          categories
        };
        this.emitter.postMessage({
          type: 'tokenUsage',
          sessionId,
          ...tokenPayload
        });
        // Persist to DB so session history shows the last token usage state
        await this.persistUiEvent(sessionId, 'tokenUsage', tokenPayload);

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
            messages.push({
              role: 'user',
              content: `[SYSTEM NOTE: Context usage: ~${usagePct}% (${remainingPct}% remaining). Be concise to preserve remaining context. Focus on completing the task efficiently.]`
            });
          }
        }

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          // Persist any accumulated thinking content before breaking so it
          // survives session restore. Without this, thinking that was visible
          // during live streaming vanishes when the session is reloaded.
          const cancelThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
          if (cancelThinking) {
            const thinkingEndTime = streamResult.lastThinkingTimestamp || Date.now();
            const durationSeconds = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
            await this.persistUiEvent(sessionId, 'thinkingBlock', { content: cancelThinking, durationSeconds });
            if (!streamResult.thinkingCollapsed) {
              this.emitter.postMessage({ type: 'collapseThinking', sessionId, durationSeconds });
            }
          }
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
          const truncMsg: any = { role: 'assistant', content: response || (thinkingContent ? '[Reasoning completed]' : '') };
          messages.push(truncMsg);
          messages.push({
            role: 'user',
            content: 'Your response was truncated due to the output length limit. Break your work into smaller pieces. Continue EXACTLY where you left off — do not repeat what you already said. If you were in the middle of a tool call, re-emit the complete tool call.'
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
        // Thinking models may signal completion only in thinking content (empty response).
        if (isCompletionSignaled(response, thinkingContent)) {
          if (taskRequiresWrite && !hasWrittenFiles) {
            const writeCheckMsg: any = { role: 'assistant', content: response || (thinkingContent ? '[Reasoning completed]' : '') };
            messages.push(writeCheckMsg);
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
              const termCheckMsg: any = { role: 'assistant', content: response || (thinkingContent ? '[Reasoning completed]' : '') };
              messages.push(termCheckMsg);
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
                const diagCheckMsg: any = { role: 'assistant', content: response || (thinkingContent ? '[Reasoning completed]' : '') };
                messages.push(diagCheckMsg);
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
        phase = 'parsing tool calls';
        let toolCalls = this.parseToolCalls(response, nativeToolCalls, useNativeTools);

        // Merge in any tool calls recovered from Ollama parse errors
        if (toolCalls.length === 0 && recoveredToolCalls.length > 0) {
          toolCalls = recoveredToolCalls;
          this.outputChannel.appendLine(`[Iteration ${iteration}] Using ${recoveredToolCalls.length} recovered tool call(s)`);
        }

        this.outputChannel.appendLine(`[Iteration ${iteration}] Parsed ${toolCalls.length} tool calls (${useNativeTools ? 'native' : 'XML'}):`);
        toolCalls.forEach((tc, i) => this.outputChannel.appendLine(`  [${i}] ${tc.name}: ${JSON.stringify(tc.args)}`));
        this.outputChannel.appendLine('---');

        // --- 6a. Deduplicate tool calls ---
        // Remove intra-batch duplicates (same tool + same args in this batch)
        // and cross-iteration duplicates (same call made in last 2 iterations).
        if (toolCalls.length > 0) {
          const seenInBatch = new Set<string>();
          const originalCount = toolCalls.length;
          const dedupedWarnings: string[] = [];

          toolCalls = toolCalls.filter(tc => {
            // Build a signature from tool name + sorted args keys/values
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
            const lastSeen = recentToolSignatures.get(sig);
            if (lastSeen !== undefined && iteration - lastSeen <= 2) {
              dedupedWarnings.push(`${tc.name} (repeated from iteration ${lastSeen})`);
              return false;
            }

            return true;
          });

          if (dedupedWarnings.length > 0) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Removed ${dedupedWarnings.length} duplicate tool call(s): ${dedupedWarnings.join(', ')}`);
          }

          // Register all surviving calls in the signature map
          for (const tc of toolCalls) {
            const argsSorted = Object.keys(tc.args || {}).sort()
              .map(k => `${k}=${JSON.stringify(tc.args[k])}`).join('&');
            recentToolSignatures.set(`${tc.name}|${argsSorted}`, iteration);
          }

          // Expire old signatures (older than 3 iterations)
          for (const [sig, iter] of recentToolSignatures) {
            if (iteration - iter > 3) recentToolSignatures.delete(sig);
          }

          // Cap batch size to prevent runaway tool invocations
          if (toolCalls.length > MAX_TOOLS_PER_BATCH) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Capping tool calls from ${toolCalls.length} to ${MAX_TOOLS_PER_BATCH}`);
            toolCalls = toolCalls.slice(0, MAX_TOOLS_PER_BATCH);
          }

          // If all tool calls were duplicates, inject a warning
          if (toolCalls.length === 0 && originalCount > 0) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] All ${originalCount} tool call(s) were duplicates — injecting warning`);
            messages.push({ role: 'assistant', content: response || '[Reasoning completed]' });
            messages.push({
              role: 'user',
              content: 'You are repeating the same tool calls you already made. The results have not changed. Please use different tools or arguments, or if you have enough information, respond with [TASK_COMPLETE].'
            });
            consecutiveNoToolIterations++;
            continue;
          }
        }

        if (toolCalls.length === 0) {
          consecutiveNoToolIterations++;
          // Thinking content fallback — see comment at truncation handler.
          const noToolMsg: any = { role: 'assistant', content: response || (thinkingContent ? '[Reasoning completed]' : '') };
          messages.push(noToolMsg);

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
            messages.push({ role: 'user', content: probeContent });
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

        // Build assistant message for conversation history.
        // Native mode: use structured tool_calls, no [Called:] duplication in content.
        // XML mode: describe calls in content (model can't see tool_calls field).
        // CRITICAL: Prefer the compact tool summary over the model's verbose
        // planning text. The response was already streamed to the UI, but
        // keeping it in history causes the model to see its own plan and
        // restate it every iteration (see Pitfall #38).
        const toolSummary = buildToolCallSummary(toolCalls);
        let assistantContent = toolSummary || response || (thinkingContent ? '[Reasoning completed]' : '');
        if (!useNativeTools && toolCalls.length > 0) {
          // XML fallback: describe calls in content since there's no tool_calls field
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
        // NO thinking field in history — see Ollama issue #10448.
        // Thinking is already persisted to the UI via thinkingBlock events.
        const assistantMsg: any = { role: 'assistant', content: assistantContent };
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        // Persist the assistant message with tool_calls metadata so that
        // multi-turn sessions can reconstruct the full tool call→result
        // pairing. IMPORTANT: Persist the original `response`, NOT `historyContent`
        // which has thinking injected. Thinking is already persisted as a separate
        // `thinkingBlock` UI event, and `iterationDelta` (the clean text) is
        // already persisted above. Persisting historyContent would triple the data
        // on session restore: thinking box + clean text + thinking-in-text.
        // Only persist here if there are tool_calls AND we didn't already persist
        // the text in section 4 (to avoid duplicate assistant messages).
        if (useNativeTools && nativeToolCalls.length > 0 && sessionId) {
          const serializedToolCalls = JSON.stringify(nativeToolCalls);
          // If iterationDelta was already persisted, persist an empty-content
          // assistant message with just the tool_calls metadata attached.
          // If no text was persisted yet, persist the clean response.
          const persistContent = hasPersistedIterationText ? '' : (response.trim() || '');
          await this.databaseService.addMessage(sessionId, 'assistant', persistContent, {
            model, toolCalls: serializedToolCalls
          });
        }

        const toolNames = toolCalls.map(tc => tc.name).join(', ');
        phase = `executing tools: ${toolNames}`;
        const batchResult = await this.toolRunner.executeBatch(
          toolCalls, context, sessionId, model, groupTitle,
          currentCheckpointId, agentSession, useNativeTools, token, messages
        );

        if (batchResult.wroteFiles) {
          hasWrittenFiles = true;

          // Record file mtimes after writes for external modification detection
          const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
          for (const relPath of uniqueFiles) {
            try {
              const absPath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
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

        if (!isTerminalOnly) {
          this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
          await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
        }

        // Feed tool results back into conversation history.
        // Native mode: use proper role:'tool' messages (Ollama API standard),
        // then a slim control packet continuation. This gives the model proper
        // tool-result association via its template renderer.
        // XML mode: wrap results in role:'user' with a control packet.
        if (useNativeTools) {
          // Push individual role:'tool' messages — the model's template renderer
          // handles these correctly (see Ollama Go renderers for each model family).
          for (const r of batchResult.nativeResults) {
            messages.push({ role: 'tool', content: r.content, tool_name: r.tool_name });
          }
          // Slim continuation — session memory is in the system prompt,
          // so we only need the control packet (iteration budget + state).
          messages.push({
            role: 'user',
            content: buildLoopContinuationMessage(
              { iteration, maxIterations: config.maxIterations, strategy: continuationStrategy, filesChanged: agentSession.filesChanged },
              { event: 'tool_results' as AgentLoopEvent, note: sessionMemory.getCompactSummary() || undefined }
            )
          });
        } else if (batchResult.xmlResults.length > 0) {
          // XML fallback: tool results go in content (no role:'tool' support).
          const toolResultText = formatTextToolResults(batchResult.xmlResults);
          messages.push({
            role: 'user',
            content: buildLoopContinuationMessage(
              { iteration, maxIterations: config.maxIterations, strategy: continuationStrategy, filesChanged: agentSession.filesChanged },
              { event: 'tool_results' as AgentLoopEvent, toolResults: toolResultText, note: sessionMemory.getCompactSummary() || undefined }
            )
          });
        }

      } catch (error: any) {
        const msgCount = messages.length;
        const errMsg = error.message || String(error);
        const errorClass = error.name && error.name !== 'Error' ? `[${error.name}] ` : '';
        const statusInfo = error.statusCode ? ` (HTTP ${error.statusCode})` : '';
        this.outputChannel.appendLine(`[AgentChatExecutor] Fatal error at iteration ${iteration}/${config.maxIterations} (${msgCount} messages, phase: ${phase}): ${errorClass}${errMsg}${statusInfo}`);
        // Show the FULL error — do not abbreviate, do not hide details
        const displayError = `${errorClass}${errMsg}${statusInfo}\n_(model: ${model}, phase: ${phase}, iteration ${iteration}/${config.maxIterations})_`;
        await this.persistUiEvent(sessionId, 'showError', { message: displayError });
        this.emitter.postMessage({ type: 'showError', message: displayError, sessionId });
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

  /**
   * Recover a tool call from an Ollama tool-parse error message.
   * Ollama fails when the model emits smart/curly/fullwidth quotes in JSON.
   * Extracts the raw JSON, replaces all Unicode quote variants with ASCII,
   * parses the result, and infers the tool name from argument keys.
   */
  private recoverToolCallFromError(
    errText: string,
    nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>,
    iteration: number
  ): { name: string; args: any } | null {
    // Match raw JSON from Ollama's error: raw='{...}', or raw='{...}' err=...
    const rawMatch = errText.match(/raw='(\{[\s\S]*?\})'/) || errText.match(/raw='(\{[\s\S]*?)' *err=/) || errText.match(/raw='(\{[\s\S]*\})/);
    if (!rawMatch) {
      this.outputChannel.appendLine(`[Iteration ${iteration}] Recovery: no raw JSON found in error text`);
      return null;
    }
    // Replace ALL Unicode quote variants with ASCII double quote
    const fixed = rawMatch[1].replace(/[\u201C\u201D\u201E\u201F\u2018\u2019\u201A\u201B\uFF02\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F\uFE41\uFE42\uFE43\uFE44]/g, '"');
    try {
      const parsed = JSON.parse(fixed);
      // Case 1: Full tool call envelope { name, arguments }
      let name = parsed?.name || parsed?.function?.name;
      let args = parsed?.arguments || parsed?.function?.arguments;
      // Case 2: Raw is just the arguments (Ollama stripped the envelope)
      if (!name) {
        args = parsed;
        const lastPartial = nativeToolCalls[nativeToolCalls.length - 1];
        name = lastPartial?.function?.name;
      }
      // Case 3: Infer tool name from argument keys
      if (!name && args) {
        if ('query' in args && !('symbolName' in args)) name = 'search_workspace';
        else if ('path' in args && 'content' in args) name = 'write_file';
        else if ('command' in args) name = 'run_terminal_command';
        else if ('symbolName' in args && 'path' in args) name = 'find_definition';
        else if ('path' in args) name = 'read_file';
      }
      if (name && args) {
        this.outputChannel.appendLine(`[Iteration ${iteration}] Recovered tool call: ${name}(${JSON.stringify(args)})`);
        return { name, args };
      }
      this.outputChannel.appendLine(`[Iteration ${iteration}] Recovery: could not determine tool name from: ${JSON.stringify(parsed)}`);
      return null;
    } catch (e) {
      this.outputChannel.appendLine(`[Iteration ${iteration}] Recovery JSON parse failed: ${e}`);
      return null;
    }
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
