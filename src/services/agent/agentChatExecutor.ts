import * as fs from 'fs';
import * as vscode from 'vscode';
import { SessionManager } from '../../agent/sessionManager';
import { ToolRegistry } from '../../agent/toolRegistry';
import { resolveMultiRootPath } from '../../agent/tools/pathUtils';
import { getConfig } from '../../config/settings';
import { ExecutorConfig } from '../../types/agent';
import { ContinuationStrategy } from '../../types/config';
import { ChatRequest, OllamaError } from '../../types/ollama';
import { MessageRecord } from '../../types/session';
import { formatDiagnostics, getErrorDiagnostics, waitForDiagnostics } from '../../utils/diagnosticWaiter';
import { extractToolCalls, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getProgressGroupTitle } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { extractContextLength, ModelCapabilities } from '../model/modelCompatibility';
import { OllamaClient } from '../model/ollamaClient';
import { PendingEditDecorationProvider } from '../pendingEditDecorationProvider';
import { TerminalManager } from '../terminalManager';
import { AgentContextCompactor, estimateTokensByCategory } from './agentContextCompactor';
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
        ? async (task: string, mode: 'explore' | 'review' | 'deep-explore') => {
            return this._exploreExecutor!.executeSubagent(task, token, sessionId, model, mode, capabilities);
          }
        : undefined
    };

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
          this.outputChannel.appendLine(`[AgentChatExecutor] Live /api/show detected context_length=${detected} for ${model}`);
        }
      } catch {
        this.outputChannel.appendLine(`[AgentChatExecutor] Live /api/show failed for ${model} — using config default num_ctx`);
      }
    }

    const allFolders = vscode.workspace.workspaceFolders || [];

    // Load project context (reads package.json, CLAUDE.md, etc.) before prompt assembly
    await this.promptBuilder.loadProjectContext(agentSession.workspace);

    const systemContent = useNativeTools
      ? this.promptBuilder.buildNativeToolPrompt(allFolders, agentSession.workspace)
      : this.promptBuilder.buildXmlFallbackPrompt(allFolders, agentSession.workspace);

    // Build messages array with conversation history for multi-turn context.
    // CRITICAL: Include role:'tool' messages so the model sees its own prior
    // tool calls and results. Without these, the model has no memory of what
    // it already did and will restate its plan and re-do searches each turn.
    // See Anthropic docs: "you must include the complete unmodified block
    // back to the API" — same principle applies to Ollama tool history.
    const historyMessages = (conversationHistory || [])
      .filter(m => {
        if (m.tool_name === '__ui__') return false;           // skip internal UI events
        if (m.role === 'tool') return !!m.content.trim();     // keep tool results with content
        if (m.role === 'user' || m.role === 'assistant') return !!m.content.trim() || !!m.tool_calls;
        return false;
      })
      .map(m => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, content: m.content, tool_name: m.tool_name || 'unknown' };
        }
        // Reconstruct tool_calls on assistant messages from DB
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

    // Track all tool calls for anti-repetition "already called" summary
    const toolCallHistory: Array<{ name: string; query: string; resultSummary: string }> = [];

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
    const continuationStrategy: ContinuationStrategy = getConfig().agent.continuationStrategy || 'full';
    let lastPromptTokens: number | undefined;

    // Loop detection: track previous iteration's tool call signatures
    let prevToolSignatures: string[] = [];
    let consecutiveDuplicateIterations = 0;

    // Text repetition detection: track previous iteration's text content
    let previousIterationText = '';
    let repetitionCorrectionNeeded = false;

    // Thinking/text repetition detection (SAFETY NET — not the primary fix).
    // The primary fix for thinking-model loops is injecting thinking content
    // into the assistant message's `content` field (see the push below).
    // These counters are a last-resort break if the model still loops.
    let previousThinkingContent = '';
    let consecutiveThinkingRepetitions = 0;
    let consecutiveTextRepetitions = 0;

    // Token usage reminder thresholds already sent (prevent duplicate injections)
    const tokenReminderSent = new Set<number>();

    // External file modification detection: after each write, record the file's
    // mtime. Before the next iteration's LLM call, check if any have changed
    // (e.g. by formatters, linters, or user edits). Adapted from Claude Code's
    // "file-opened-in-ide" system reminder pattern.
    const fileWriteTimestamps = new Map<string, number>();

    // IDE file focus tracking: detect when the user switches files during the
    // agent session and inject a brief note. Helps the model stay aware of
    // user intent without requiring explicit messages.
    let lastActiveEditorPath: string | undefined = vscode.window.activeTextEditor?.document.uri.fsPath;

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;
      repetitionCorrectionNeeded = false;

      // Diagnostic: log conversation state at each iteration start
      const totalContentChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      const roleCounts = messages.reduce((acc: Record<string, number>, m) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
      }, {});
      const roleBreakdown = Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(', ');
      this.outputChannel.appendLine(`[Iteration ${iteration}] Messages: ${messages.length} (${roleBreakdown}) — ~${Math.round(totalContentChars / 4)} est. tokens — toolCallHistory: ${toolCallHistory.length} calls`);

      let phase = 'preparing request';

      try {
        // --- 0. Compact conversation history if approaching context limit ---
        // contextWindow: detected model capacity (display-only) — used for the
        //   compaction threshold and the token usage indicator in the UI.
        //   We do NOT send num_ctx to Ollama; let it manage its own KV cache.
        const detectedContextWindow = capabilities?.contextLength;
        const userContextWindow = getConfig().contextWindow || 16000;
        const contextWindow = detectedContextWindow || userContextWindow;
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
        const { agentMode: modeConfig } = getConfig();
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

        phase = 'streaming response from model';
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
          this.outputChannel.appendLine(`[Iteration ${iteration}] Token usage: prompt=${streamResult.promptTokens}, completion=${streamResult.completionTokens ?? '?'}, context_window=${contextWindow}`);
        }

        // Emit token usage to the webview for the live indicator
        const toolDefCount = useNativeTools ? this.toolRegistry.getOllamaToolDefinitions().length : 0;
        const categories = estimateTokensByCategory(messages, toolDefCount, lastPromptTokens);
        this.emitter.postMessage({
          type: 'tokenUsage',
          sessionId,
          promptTokens: lastPromptTokens ?? categories.total,
          completionTokens: streamResult.completionTokens,
          contextWindow,
          categories
        });

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
          messages.push({ role: 'assistant', content: response });
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

          // --- Thinking repetition detection (SAFETY NET) ---
          // The primary fix for thinking-model loops is in the assistant
          // message push below (thinking content injected into `content`).
          // This detection is a last-resort safety net for pathological cases.
          if (previousThinkingContent) {
            const thinkSimilarity = textSimilarity(displayThinking, previousThinkingContent);
            if (thinkSimilarity > 0.6) {
              consecutiveThinkingRepetitions++;
              this.outputChannel.appendLine(`[Iteration ${iteration}] Thinking repetition detected (${Math.round(thinkSimilarity * 100)}% similar, streak: ${consecutiveThinkingRepetitions})`);
              repetitionCorrectionNeeded = true;

              if (consecutiveThinkingRepetitions >= 4) {
                this.outputChannel.appendLine(`[Iteration ${iteration}] HARD BREAK — ${consecutiveThinkingRepetitions} consecutive thinking repetitions. Model is stuck in a loop.`);
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

        // --- 4. Process per-iteration delta text ---
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();

        if (iterationDelta) {
          // Repetition detection: when the model restates the same plan across
          // iterations, course-correct by injecting a corrective message into
          // history. IMPORTANT: Do NOT use `continue` here — the model may
          // have generated tool calls alongside the repetitive text. Skipping
          // tool execution would prevent any progress and cause more repetition.
          const similarity = previousIterationText.length > 0
            ? textSimilarity(iterationDelta, previousIterationText) : 0;
          const isRepetitiveText = similarity > 0.7;

          previousIterationText = iterationDelta;

          if (isRepetitiveText) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Repetitive text detected (${Math.round(similarity * 100)}% similar) — injecting correction, suppressing UI`);
            // Don't stream to UI or persist — but DO continue to tool execution below
            repetitionCorrectionNeeded = true;
            consecutiveTextRepetitions++;
            if (consecutiveTextRepetitions >= 5) {
              this.outputChannel.appendLine(`[Iteration ${iteration}] HARD BREAK — ${consecutiveTextRepetitions} consecutive text repetitions`);
              break;
            }
          } else {
            consecutiveTextRepetitions = 0;
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

        if (toolCalls.length === 0) {
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
                continuationStrategy, agentSession.filesChanged || [],
                undefined, agentSession.task, toolCallHistory
              )
            });
          }
          continue;
        }

        // Tools found — reset the no-tool counter
        consecutiveNoToolIterations = 0;

        // --- Loop detection: check for repeated tool call patterns ---
        const currentSignatures = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.args)}`);
        const duplicateCount = currentSignatures.filter(sig => prevToolSignatures.includes(sig)).length;
        const isDuplicate = prevToolSignatures.length > 0 && duplicateCount >= Math.ceil(currentSignatures.length * 0.5);

        if (isDuplicate) {
          consecutiveDuplicateIterations++;
          this.outputChannel.appendLine(`[Iteration ${iteration}] Duplicate tool calls detected (${duplicateCount}/${currentSignatures.length} repeated, streak: ${consecutiveDuplicateIterations})`);
          if (consecutiveDuplicateIterations >= 2) {
            this.outputChannel.appendLine(`[Iteration ${iteration}] Breaking: ${consecutiveDuplicateIterations} consecutive duplicate iterations — model is looping`);
            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: 'STOP. You are repeating the same tool calls you already made in previous iterations. The results have not changed. Either take a DIFFERENT approach to solve the task, or respond with [TASK_COMPLETE] explaining what you found.'
            });
            // Give the model one more chance with the nudge before breaking
            if (consecutiveDuplicateIterations >= 3) break;
            prevToolSignatures = currentSignatures;
            continue;
          }
        } else {
          consecutiveDuplicateIterations = 0;
        }
        prevToolSignatures = currentSignatures;

        // --- 7. Execute tool batch ---
        const groupTitle = getProgressGroupTitle(toolCalls);
        const isTerminalOnly = toolCalls.every(t => t.name === 'run_terminal_command' || t.name === 'run_command');

        // Skip progress group wrapper for terminal-only batches — the approval card is sufficient
        if (!isTerminalOnly) {
          this.emitter.postMessage({ type: 'startProgressGroup', title: groupTitle, sessionId });
          await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });
        }

        // Push assistant message to conversation history.
        // CRITICAL: With thinking models, the real plan/reasoning lives in
        // `thinking` but that field may not replay properly in all Ollama model
        // architectures. When the response is empty/minimal, the model enters
        // the next iteration with NO memory of what it planned — and re-derives
        // the same plan from scratch, causing infinite loops.
        // Fix: inject thinking content into `content` so the model always sees
        // its own previous reasoning in the conversation history.
        let historyContent = response;
        if (thinkingContent && response.trim().length < 200) {
          // Truncate to manage context growth. Prefer the END of thinking
          // (conclusions/decisions) over the beginning (deliberation).
          const maxLen = 800;
          historyContent = thinkingContent.length > maxLen
            ? '...' + thinkingContent.substring(thinkingContent.length - maxLen)
            : thinkingContent;
        }
        const assistantMsg: any = { role: 'assistant', content: historyContent };
        if (thinkingContent) assistantMsg.thinking = thinkingContent;
        if (useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
        messages.push(assistantMsg);

        // Persist the assistant message with tool_calls metadata so that
        // multi-turn sessions can reconstruct the full tool call→result
        // pairing. We persist historyContent (which includes thinking when
        // response was empty) so that loaded sessions also have context.
        if (useNativeTools && nativeToolCalls.length > 0 && sessionId) {
          const serializedToolCalls = JSON.stringify(nativeToolCalls);
          await this.databaseService.addMessage(sessionId, 'assistant', historyContent || '', {
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

        // Build tool call history for anti-repetition summary in continuation
        for (let idx = 0; idx < toolCalls.length; idx++) {
          const tc = toolCalls[idx];
          const output = useNativeTools
            ? (batchResult.nativeResults[idx]?.content ?? '')
            : (batchResult.xmlResults[idx] ?? '');
          const argsStr = Object.entries(tc.args || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
          const firstLine = output.split('\n')[0]?.substring(0, 100) || '(empty)';
          toolCallHistory.push({ name: tc.name, query: argsStr, resultSummary: firstLine });
        }

        if (!isTerminalOnly) {
          this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
          await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
        }

        // Feed tool results back into conversation history
        if (useNativeTools) {
          messages.push(...batchResult.nativeResults);

          // CRITICAL: After native tool results, inject a short task-anchoring
          // reminder. Without this, large tool outputs (e.g. a 500-line file
          // read) dominate the model's attention and it forgets the original
          // task — especially smaller models (≤20B params).
          const remaining = config.maxIterations - iteration - 1;
          const taskPreview = agentSession.task.length > 200
            ? agentSession.task.substring(0, 200) + '…'
            : agentSession.task;
          const reminderParts = [
            `[Iteration ${iteration + 1}/${config.maxIterations} — ${remaining} remaining]`,
            `Reminder — your task: ${taskPreview}`,
            `Proceed directly with tool calls or [TASK_COMPLETE]. Do NOT restate your plan or summarize what you just did.`
          ];
          // Files modified context helps the model avoid re-editing the same files
          if (agentSession.filesChanged?.length > 0) {
            const uniqueFiles = [...new Set(agentSession.filesChanged as string[])];
            const fileList = uniqueFiles.length <= 5
              ? uniqueFiles.join(', ')
              : `${uniqueFiles.slice(0, 5).join(', ')} (+${uniqueFiles.length - 5} more)`;
            reminderParts.push(`Files modified so far: ${fileList}`);
          }
          // Anti-repetition: tell the model what tools it already called
          if (toolCallHistory.length > 0) {
            const historyLines = toolCallHistory.map(h => `  - ${h.name}(${h.query}) → ${h.resultSummary}`);
            reminderParts.push(`Tools already called this session (do NOT repeat these):\n${historyLines.join('\n')}`);
          }
          messages.push({
            role: 'user',
            content: reminderParts.join('\n')
          });
        } else if (batchResult.xmlResults.length > 0) {
          const toolResultText = batchResult.xmlResults.join('\n\n');
          messages.push({
            role: 'user',
            content: this.buildContinuationMessage(
              iteration, config.maxIterations, sessionMemory,
              continuationStrategy, agentSession.filesChanged || [],
              toolResultText, agentSession.task, toolCallHistory
            )
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

  /** Build a strategy-aware continuation message for the agent loop. */
  private buildContinuationMessage(
    iteration: number,
    maxIterations: number,
    sessionMemory: AgentSessionMemory,
    strategy: ContinuationStrategy,
    filesChanged: string[],
    toolResults?: string,
    originalTask?: string,
    toolCallHistory?: Array<{ name: string; query: string; resultSummary: string }>
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

      // Task reminder — critical for keeping the model focused after errors
      // or when several tool results push the original request out of attention
      if (originalTask) {
        const taskPreview = originalTask.length > 200
          ? originalTask.substring(0, 200) + '…'
          : originalTask;
        parts.push(`Task: ${taskPreview}`);
      }

      // Files modified so far
      if (filesChanged.length > 0) {
        const uniqueFiles = [...new Set(filesChanged)];
        const fileList = uniqueFiles.length <= 5
          ? uniqueFiles.join(', ')
          : `${uniqueFiles.slice(0, 5).join(', ')} (+${uniqueFiles.length - 5} more)`;
        parts.push(`Files modified: ${fileList}`);
      }

      // Anti-repetition: tell the model what tools it already called
      if (toolCallHistory && toolCallHistory.length > 0) {
        const historyLines = toolCallHistory.map(h => `  - ${h.name}(${h.query}) → ${h.resultSummary}`);
        parts.push(`Tools already called this session (do NOT repeat these):\n${historyLines.join('\n')}`);
      }

      // Session memory summary
      const memorySummary = sessionMemory.getCompactSummary();
      if (memorySummary) {
        parts.push(`Memory: ${memorySummary}`);
      }
    } else if (strategy === 'standard' && originalTask) {
      // Standard strategy: include abbreviated task reminder
      const taskPreview = originalTask.length > 100
        ? originalTask.substring(0, 100) + '…'
        : originalTask;
      parts.push(`Task: ${taskPreview}`);
      // Even in standard mode, include tool history to prevent repetition
      if (toolCallHistory && toolCallHistory.length > 0) {
        const historyLines = toolCallHistory.map(h => `  - ${h.name}(${h.query}) → ${h.resultSummary}`);
        parts.push(`Tools already called (do NOT repeat):\n${historyLines.join('\n')}`);
      }
    }

    parts.push('Continue with the task. Do NOT restate your plan — proceed directly with tool calls or respond with [TASK_COMPLETE] if finished.');
    return parts.join('\n');
  }

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
