import * as path from 'path';
import * as vscode from 'vscode';
import { GitOperations } from '../../agent/gitOperations';
import { SessionManager } from '../../agent/sessionManager';
import { getConfig, getModeConfig } from '../../config/settings';
import { AgentChatExecutor } from '../../services/agent/agentChatExecutor';
import { AgentDispatcher } from '../../services/agent/agentDispatcher';
import { AgentExploreExecutor, ExploreMode } from '../../services/agent/agentExploreExecutor';
import { generateSessionTitle } from '../../services/agent/titleGenerator';
import { DatabaseService } from '../../services/database/databaseService';
import { getModelCapabilities, ModelCapabilities } from '../../services/model/modelCompatibility';
import { OllamaClient } from '../../services/model/ollamaClient';
import { PendingEditReviewService } from '../../services/review/pendingEditReviewService';
import { TokenManager } from '../../services/tokenManager';
import { DispatchResult, ExecutorConfig } from '../../types/agent';
import { Model } from '../../types/ollama';
import { ChatSessionStatus, MessageRecord } from '../../types/session';
import { ChatSessionController } from '../chatSessionController';
import { ChatMessage, ContextItem, IMessageHandler, ViewState, WebviewMessageEmitter } from '../chatTypes';
import { SettingsHandler } from '../settingsHandler';
import { mergeCachedCapabilities, ModelMessageHandler } from './modelMessageHandler';

/**
 * Handles core chat lifecycle messages: init, send, stop, model/mode selection, new chat, add context.
 * This is the largest handler because it owns the main message flow and agent/chat orchestration.
 */
export class ChatMessageHandler implements IMessageHandler {
  readonly handledTypes = [
    'ready', 'sendMessage', 'stopGeneration', 'selectModel', 'selectMode', 'newChat', 'addContext',
    'addContextFromFile', 'addContextCurrentFile', 'addContextFromTerminal', 'implementPlan',
    'setSessionExplorerModel'
  ] as const;

  private cancellationTokenSource?: vscode.CancellationTokenSource;
  private readonly dispatcher: AgentDispatcher;

  constructor(
    private readonly state: ViewState,
    private readonly emitter: WebviewMessageEmitter,
    private readonly sessionController: ChatSessionController,
    private readonly settingsHandler: SettingsHandler,
    private readonly agentExecutor: AgentChatExecutor,
    private readonly exploreExecutor: AgentExploreExecutor,
    private readonly databaseService: DatabaseService,
    private readonly client: OllamaClient,
    private readonly tokenManager: TokenManager,
    private readonly sessionManager: SessionManager,
    private readonly gitOps: GitOperations,
    private readonly modelHandler: ModelMessageHandler,
    private readonly reviewService?: PendingEditReviewService,
  ) {
    this.dispatcher = new AgentDispatcher(
      client,
      vscode.window.createOutputChannel('Ollama Copilot Dispatcher', { log: true })
    );
  }

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'ready':
        await this.initialize(data.sessionId);
        await this.settingsHandler.sendSettingsUpdate();
        break;
      case 'sendMessage':
        await this.handleMessage(data.text, data.context);
        break;
      case 'stopGeneration':
        this.stopGeneration(data.sessionId);
        break;
      case 'selectModel':
        await this.handleModelChange(data.model);
        break;
      case 'setSessionExplorerModel':
        await this.handleSetSessionExplorerModel(data.model);
        break;
      case 'selectMode':
        this.state.currentMode = data.mode;
        break;
      case 'newChat': {
        const idleSessionId = await this.databaseService.findIdleEmptySession();
        if (idleSessionId) {
          await this.sessionController.loadSession(idleSessionId);
        } else {
          await this.sessionController.createNewSession(this.state.currentMode, this.state.currentModel);
          this.emitter.postMessage({ type: 'clearMessages', sessionId: this.sessionController.getCurrentSessionId() });
          this.emitter.postMessage({
            type: 'sessionApprovalSettings',
            sessionId: this.sessionController.getCurrentSessionId(),
            autoApproveCommands: false,
            autoApproveSensitiveEdits: false,
            sessionSensitiveFilePatterns: null
          });
          await this.sessionController.sendSessionsList();
        }
        break;
      }
      case 'addContext':
        await this.handleAddContext();
        break;
      case 'addContextFromFile':
        await this.handleAddContextFromFile();
        break;
      case 'addContextCurrentFile':
        await this.handleAddContextCurrentFile();
        break;
      case 'addContextFromTerminal':
        await this.handleAddContextFromTerminal();
        break;
      case 'implementPlan':
        await this.handleImplementPlan(data.planContent);
        break;
    }
  }

  private async initialize(requestedSessionId?: string) {
    const settings = this.settingsHandler.getSettingsPayload();
    const hasToken = await this.tokenManager.hasToken();

    // Run session loading and model listing in parallel
    const sessionLoadPromise = (async () => {
      // Try to restore the session the webview was showing before collapse
      if (requestedSessionId) {
        const session = await this.databaseService.getSession(requestedSessionId);
        if (session) {
          await this.sessionController.loadSession(requestedSessionId);
          return;
        }
      }
      if (!this.sessionController.getCurrentSessionId()) {
        const recentSessions = await this.databaseService.listSessions(1);
        if (recentSessions.sessions.length > 0) {
          await this.sessionController.loadSession(recentSessions.sessions[0].id);
        } else {
          await this.sessionController.createNewSession(this.state.currentMode, this.state.currentModel);
        }
      }
    })();

    const modelListPromise = (async () => {
      try {
        const fetched = await this.client.listModels();
        // Merge capabilities from SQLite cache so the UI isn't blank
        await mergeCachedCapabilities(this.databaseService, fetched);
        // Persist basic model info (fire-and-forget)
        this.databaseService.upsertModels(fetched).catch(err =>
          console.warn('[ChatMessageHandler] Failed to cache models:', err)
        );
        return fetched;
      } catch (err: any) {
        console.warn('Failed to list models during init:', err);
        // Fall back to cached models from SQLite
        try { return await this.databaseService.getCachedModels(); } catch { /* ignore */ }
        return [] as Model[];
      }
    })();

    const [, models] = await Promise.all([sessionLoadPromise, modelListPromise]);

    const modeConfig = getModeConfig('agent');
    this.state.currentModel = modeConfig.model || (models.length > 0 ? models[0].name : '');

    this.emitter.postMessage({
      type: 'init',
      models: models.map((m: any) => {
        const caps = getModelCapabilities(m);
        return {
          name: m.name,
          selected: m.name === this.state.currentModel,
          size: m.size ?? 0,
          parameterSize: m.details?.parameter_size ?? undefined,
          quantizationLevel: m.details?.quantization_level ?? undefined,
          capabilities: caps,
          enabled: m.enabled !== false
        };
      }),
      currentMode: this.state.currentMode,
      settings,
      hasToken
    });

    // Populate the sessions list for the sidebar
    await this.sessionController.sendSessionsList();

    // Auto-pull capabilities in background for models that don't have them yet
    if (models.length > 0) {
      this.modelHandler.refreshCapabilities(/* onlyMissing */ true);
    }

    if (models.length === 0) {
      this.emitter.postMessage({
        type: 'connectionError',
        error: 'No models available. Check your Ollama connection.'
      });
    }
  }

  private async handleAddContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const fileName = vscode.workspace.asRelativePath(editor.document.uri, true);
      const lineInfo = selection.isEmpty ? '' : `:${selection.start.line + 1}`;

      this.emitter.postMessage({
        type: 'addContextItem',
        context: {
          fileName: fileName + lineInfo,
          content: text.substring(0, 8000)
        }
      });
    }
  }

  /** Open a file picker and add selected files to context. */
  private async handleAddContextFromFile() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Add to Context',
      filters: { 'All Files': ['*'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!uris || uris.length === 0) return;

    for (const uri of uris) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const content = doc.getText().substring(0, 8000);
        const fileName = vscode.workspace.asRelativePath(uri, true);
        this.emitter.postMessage({
          type: 'addContextItem',
          context: { fileName, content, languageId: doc.languageId }
        });
      } catch {
        // skip binary / unreadable files
      }
    }
  }

  /** Add the entire active file to context (not just the selection). */
  private async handleAddContextCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const fileName = vscode.workspace.asRelativePath(doc.uri, true);
    this.emitter.postMessage({
      type: 'addContextItem',
      context: {
        fileName,
        content: doc.getText().substring(0, 8000),
        languageId: doc.languageId
      }
    });
  }

  /** Read the active terminal buffer and add to context. */
  private async handleAddContextFromTerminal() {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      this.emitter.postMessage({
        type: 'addContextItem',
        context: { fileName: 'Terminal (empty)', content: 'No active terminal.' }
      });
      return;
    }
    // Use the shellIntegration API to get recent output, else fall back to name
    let content = `Terminal: ${terminal.name}\n(Terminal buffer cannot be read via the API. Copy/paste the relevant output.)`;
    // If VS Code ≥ 1.93 shellIntegration is available, try to read last command output
    try {
      const si = (terminal as any).shellIntegration;
      if (si?.history) {
        const entries = [...si.history].slice(-5);
        content = entries.map((e: any) =>
          `$ ${e.command}\n${e.output?.join('\n') ?? ''}`
        ).join('\n\n');
      }
    } catch { /* fallback is fine */ }

    this.emitter.postMessage({
      type: 'addContextItem',
      context: { fileName: `Terminal: ${terminal.name}`, content: content.substring(0, 8000) }
    });
  }

  private stopGeneration(sessionId?: string) {
    const targetSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const tokenSource = targetSessionId ? this.state.activeSessions.get(targetSessionId) : undefined;
    if (tokenSource) {
      tokenSource.cancel();
      this.state.activeSessions.delete(targetSessionId);
    }
    if (this.cancellationTokenSource === tokenSource) {
      this.cancellationTokenSource = undefined;
    }
    this.emitter.postMessage({ type: 'generationStopped', sessionId: targetSessionId });
    void this.sessionController.setSessionStatus('completed', targetSessionId);
  }

  private async handleMessage(text: string, contextItems?: ContextItem[]) {
    if (!text.trim()) return;

    const sessionIdAtStart = this.sessionController.getCurrentSessionId();
    const session = await this.sessionController.getCurrentSession();
    if (!session || !sessionIdAtStart) return;

    console.log('handleMessage received user input:', {
      sessionId: sessionIdAtStart,
      textLength: text.length,
      mode: this.state.currentMode
    });

    const sessionMessagesSnapshot = [...this.sessionController.getCurrentMessages()];
    const { agent } = getConfig();

    if (this.state.activeSessions.has(sessionIdAtStart)) {
      return;
    }

    if (this.state.activeSessions.size >= agent.maxActiveSessions) {
      this.emitter.postMessage({
        type: 'addMessage',
        sessionId: sessionIdAtStart,
        message: {
          role: 'assistant',
          content: 'Too many sessions are running. Stop a session or increase the limit in Settings → Agent → Max Active Sessions.'
        }
      });
      return;
    }

    const tokenSource = new vscode.CancellationTokenSource();
    this.cancellationTokenSource = tokenSource;
    this.state.activeSessions.set(sessionIdAtStart, tokenSource);
    const token = tokenSource.token;
    await this.sessionController.setSessionStatus('generating', sessionIdAtStart);

    let contextStr = '';
    if (contextItems && contextItems.length > 0) {
      // Resolve __implicit_file__ markers — the webview sends this placeholder
      // for implicit file context; we read the actual content here.
      const resolved = await Promise.all(contextItems.map(async (c) => {
        if (c.content === '__implicit_file__') {
          try {
            // Try matching the active editor by relative path or basename
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              const editorRelative = vscode.workspace.asRelativePath(editor.document.uri, true);
              const editorBasename = path.basename(editor.document.uri.fsPath);
              if (c.fileName === editorRelative || c.fileName === editorBasename) {
                return { ...c, content: editor.document.getText().substring(0, 8000) };
              }
            }
            // Fallback: search workspace for the file by relative path or basename
            const searchPattern = c.fileName.includes('/') ? c.fileName : `**/${c.fileName}`;
            const uris = await vscode.workspace.findFiles(searchPattern, undefined, 1);
            if (uris.length > 0) {
              const doc = await vscode.workspace.openTextDocument(uris[0]);
              return { ...c, content: doc.getText().substring(0, 8000) };
            }
          } catch { /* use marker as-is */ }
        }
        return c;
      }));
      contextStr = resolved.map(c => {
        const hasLineRange = /:\s*L\d+/.test(c.fileName);
        const label = hasLineRange
          ? `User's selected code from ${c.fileName} (already provided — do not re-read):`
          : `Contents of ${c.fileName} (already provided — do not re-read):`;
        return `${label}\n\`\`\`\n${c.content}\n\`\`\``;
      }).join('\n\n');

      // LSP pre-analysis: analyze provided code to give the model a head start.
      // Extract document symbols in the selection range so the model knows what
      // functions/methods exist and can jump straight to tracing with find_definition
      // instead of re-reading the file.
      const analysisBlocks = await Promise.all(resolved.map(async (c) => {
        try {
          // Extract base file path (strip :L10-L50 suffix)
          const filePathMatch = c.fileName.match(/^(.+?)(?::L\d+)?$/);
          if (!filePathMatch) return '';
          const relPath = filePathMatch[1];

          // Resolve to URI
          const searchPattern = relPath.includes('/') ? relPath : `**/${relPath}`;
          const uris = await vscode.workspace.findFiles(searchPattern, undefined, 1);
          if (uris.length === 0) return '';
          const uri = uris[0];

          // Get document symbols from the language server
          const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider', uri
          );
          if (!symbols || symbols.length === 0) return '';

          // Determine line range of the selection (if any)
          const rangeMatch = c.fileName.match(/:L(\d+)-L(\d+)/);
          const startLine = rangeMatch ? parseInt(rangeMatch[1], 10) - 1 : 0;
          const endLine = rangeMatch ? parseInt(rangeMatch[2], 10) - 1 : Infinity;

          // Collect symbols within the selection range (recursively)
          const relevant: string[] = [];
          const collectSymbols = (syms: vscode.DocumentSymbol[], depth: number) => {
            for (const sym of syms) {
              const symStart = sym.range.start.line;
              const symEnd = sym.range.end.line;
              // Symbol overlaps with selection
              if (symEnd >= startLine && symStart <= endLine) {
                const kindName = vscode.SymbolKind[sym.kind] || 'Unknown';
                const indent = '  '.repeat(depth);
                relevant.push(`${indent}${kindName}: ${sym.name} (lines ${symStart + 1}-${symEnd + 1})`);
                if (sym.children && sym.children.length > 0) {
                  collectSymbols(sym.children, depth + 1);
                }
              }
            }
          };
          collectSymbols(symbols, 0);

          if (relevant.length === 0) return '';

          return `\nCode structure in ${c.fileName}:\n${relevant.join('\n')}\nUse find_definition and get_call_hierarchy to trace each function call to its source before writing any output.`;
        } catch {
          return ''; // LSP not available — skip silently
        }
      }));

      const analysisStr = analysisBlocks.filter(Boolean).join('\n');
      if (analysisStr) {
        contextStr += '\n' + analysisStr;
      }
    }

    const fullPrompt = contextStr ? `${contextStr}\n\n${text}` : text;

    console.log('Persisting user message to database:', { sessionId: sessionIdAtStart });
    const userMessage = await this.databaseService.addMessage(sessionIdAtStart, 'user', text);
    if (this.sessionController.getCurrentSessionId() === sessionIdAtStart) {
      this.sessionController.pushMessage(userMessage);
    }

    if (sessionMessagesSnapshot.length === 0) {
      // Always set an immediate fallback title from the message text
      const fallbackTitle = text.substring(0, 40) + (text.length > 40 ? '...' : '');
      await this.databaseService.updateSession(sessionIdAtStart, { title: fallbackTitle });
      await this.sessionController.sendSessionsList();

      // If configured, fire-and-forget model-generated title in background.
      // The fallback title remains until the model responds. If the model
      // times out (15s) or fails, the fallback stays.
      const { agent: agentConf } = getConfig();
      const titleMode = agentConf.sessionTitleGeneration || 'firstMessage';
      let titleModel: string | undefined;
      if (titleMode === 'currentModel') {
        titleModel = this.state.currentModel;
      } else if (titleMode === 'selectModel' && agentConf.sessionTitleModel) {
        titleModel = agentConf.sessionTitleModel;
      }
      if (titleModel) {
        generateSessionTitle(this.client, titleModel, text).then(async (title) => {
          if (title) {
            try {
              await this.databaseService.updateSession(sessionIdAtStart, { title });
              await this.sessionController.sendSessionsList();
            } catch { /* non-fatal — keep fallback title */ }
          }
        }).catch(() => { /* non-fatal — keep fallback title */ });
      }
    }

    // Build context file references for UI display (names only, no content)
    const contextFiles = contextItems?.map(c => ({
      fileName: c.fileName,
      kind: c.kind,
      lineRange: c.lineRange,
    })).filter(f => f.fileName) || [];

    const chatMessage: ChatMessage = { role: 'user', content: text, timestamp: userMessage.timestamp };
    this.emitter.postMessage({ type: 'addMessage', message: chatMessage, contextFiles, sessionId: sessionIdAtStart });

    // Persist context file references as a __ui__ event so session history can reconstruct them
    if (contextFiles.length > 0) {
      try {
        await this.databaseService.addMessage(sessionIdAtStart, 'tool', '', {
          toolName: '__ui__',
          toolOutput: JSON.stringify({ eventType: 'contextFiles', payload: { files: contextFiles } })
        });
      } catch { /* non-fatal */ }
    }

    this.emitter.postMessage({ type: 'generationStarted', sessionId: sessionIdAtStart });

    if (!this.state.currentModel) {
      await this.sessionController.setSessionStatus('error', sessionIdAtStart);
      this.state.activeSessions.delete(sessionIdAtStart);
      this.emitter.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
      this.emitter.postMessage({ type: 'showError', message: 'No model selected', sessionId: sessionIdAtStart });
      return;
    }

    let finalStatus: ChatSessionStatus = 'completed';
    try {
      // Slash commands — work in any mode
      const slashCommand = this.detectSlashCommand(text);
      if (slashCommand) {
        const slashPrompt = this.extractSlashPrompt(text, fullPrompt, slashCommand.prefix);
        await this.handleExploreMode(slashPrompt, token, sessionIdAtStart, slashCommand.mode, sessionMessagesSnapshot);
      } else if (this.state.currentMode === 'agent') {
        await this.handleAgentMode(fullPrompt, token, sessionIdAtStart, sessionMessagesSnapshot);
      } else if (this.state.currentMode === 'plan') {
        await this.handleExploreMode(fullPrompt, token, sessionIdAtStart, 'plan', sessionMessagesSnapshot);
      } else {
        // 'chat' mode — routes through ExploreExecutor with read-only tools
        await this.handleExploreMode(fullPrompt, token, sessionIdAtStart, 'chat', sessionMessagesSnapshot);
      }
    } catch (error: any) {
      finalStatus = 'error';
      this.emitter.postMessage({ type: 'showError', message: error.message, sessionId: sessionIdAtStart });
    } finally {
      await this.sessionController.setSessionStatus(finalStatus, sessionIdAtStart);
      this.state.activeSessions.delete(sessionIdAtStart);
      this.emitter.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
      // Refresh session list so pending stats badge appears immediately
      await this.sessionController.sendSessionsList();
    }
  }

  /**
   * Detect which workspace folder the user is most likely working in,
   * based on the active editor URI, then falling back to workspaceFolders[0].
   */
  private detectPrimaryWorkspace(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    if (folders.length === 1) return folders[0];

    // Prefer the workspace folder that contains the active editor's file
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const match = vscode.workspace.getWorkspaceFolder(activeUri);
      if (match) return match;
    }

    // Fallback: check all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      const match = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (match) return match;
    }

    return folders[0];
  }

  private async handleAgentMode(prompt: string, token: vscode.CancellationToken, sessionId: string, sessionMessages?: MessageRecord[]) {
    const workspace = this.detectPrimaryWorkspace();
    if (!workspace) {
      this.emitter.postMessage({ type: 'showError', message: 'No workspace folder open', sessionId });
      return;
    }

    // --- Intent classification ---
    // Show spinner while the LLM classifies the request (no timeout — waits for response).
    this.emitter.postMessage({ type: 'showThinking', message: 'Analyzing request...', sessionId });

    let dispatch: DispatchResult;
    try {
      dispatch = await this.dispatcher.classify(prompt, this.state.currentModel);
    } catch {
      // If classification fails entirely, default to mixed (full agent, standard prompt)
      dispatch = { intent: 'mixed', needsWrite: true, confidence: 0, reasoning: 'Classification failed — defaulting to mixed' };
    }

    // ALL intents (including 'analyze') go through the orchestrator.
    // The orchestrator delegates research to sub-agents via run_subagent,
    // ensuring proper tool dedup, over-eager mitigation, and staged delegation.

    const agentSession = this.sessionManager.createSession(prompt, this.state.currentModel, workspace);

    const config: ExecutorConfig = { maxIterations: getConfig().agent.maxIterations, toolTimeout: getConfig().agent.toolTimeout, temperature: 0.7 };

    // Resolve explorer model: session override → global setting → agent model (empty = same as orchestrator)
    const sessionExplorer = this.sessionController.getSessionExplorerModel();
    const globalExplorer = getConfig().agent.explorerModel;
    config.explorerModel = sessionExplorer || globalExplorer || '';

    // Fetch model capabilities to decide native vs XML tool calling
    let capabilities: ModelCapabilities | undefined;
    try {
      const cached = await this.databaseService.getCachedModels();
      const modelRecord = cached.find(m => m.name === this.state.currentModel);
      if (modelRecord) {
        capabilities = getModelCapabilities(modelRecord);
      }
    } catch { /* proceed without — executor will default to XML fallback */ }

    // Wire explore executor for sub-agent tool support
    this.agentExecutor.exploreExecutor = this.exploreExecutor;

    // Register per-file review callback so CodeLens appears as each file is written
    if (this.reviewService) {
      const reviewSvc = this.reviewService;
      const emitter = this.emitter;
      this.agentExecutor.onFileWritten = (checkpointId: string) => {
        reviewSvc.startReviewForCheckpoint(checkpointId).then(() => {
          const pos = reviewSvc.getChangePosition(checkpointId);
          if (pos) {
            emitter.postMessage({ type: 'reviewChangePosition', checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
          }
        }).catch(() => {});
      };
    }

    const result = await this.agentExecutor.execute(agentSession, config, token, sessionId, this.state.currentModel, capabilities, sessionMessages, dispatch);

    // Clear the per-write callback
    this.agentExecutor.onFileWritten = undefined;

    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(result.assistantMessage);
    }

    // Auto-start inline review for any already-open editors
    if (result.checkpointId && this.reviewService) {
      await this.reviewService.startReviewForCheckpoint(result.checkpointId);
      const pos = this.reviewService.getChangePosition(result.checkpointId);
      if (pos) {
        this.emitter.postMessage({ type: 'reviewChangePosition', checkpointId: result.checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
      }
    }
  }

  private async handleExploreMode(prompt: string, token: vscode.CancellationToken, sessionId: string, mode: ExploreMode, sessionMessages?: MessageRecord[]) {
    this.emitter.postMessage({ type: 'showThinking', message: mode === 'review' ? 'Starting security review...' : 'Exploring codebase...', sessionId });

    let capabilities: ModelCapabilities | undefined;
    try {
      const cached = await this.databaseService.getCachedModels();
      const modelRecord = cached.find(m => m.name === this.state.currentModel);
      if (modelRecord) {
        capabilities = getModelCapabilities(modelRecord);
      }
    } catch { /* proceed without */ }

    const config: ExecutorConfig = { maxIterations: getConfig().agent.maxIterations, toolTimeout: getConfig().agent.toolTimeout, temperature: 0.7 };

    const primaryWorkspace = this.detectPrimaryWorkspace();
    const result = await this.exploreExecutor.execute(prompt, config, token, sessionId, this.state.currentModel, mode, capabilities, sessionMessages, /* isSubagent */ false, primaryWorkspace);

    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(result.assistantMessage);
    }

    // Send plan handoff button when plan mode completes successfully
    if (mode === 'plan' && result.summary) {
      this.emitter.postMessage({ type: 'planReady', planContent: result.summary, sessionId });
      // Persist so session history shows the handoff button
      try {
        await this.databaseService.addMessage(sessionId, 'tool', '', {
          toolName: '__ui__',
          toolOutput: JSON.stringify({ eventType: 'planReady', payload: { planContent: result.summary } })
        });
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Handle plan handoff: switch to agent mode and send the plan as a prompt.
   * Creates a new session so the implementation is tracked separately.
   */
  private async handleImplementPlan(planContent: string) {
    if (!planContent) return;

    // Switch to agent mode
    this.state.currentMode = 'agent';
    this.emitter.postMessage({ type: 'modeChanged', mode: 'agent' });

    // Create a new session for implementation
    await this.sessionController.createNewSession('agent', this.state.currentModel);
    this.emitter.postMessage({ type: 'clearMessages', sessionId: this.sessionController.getCurrentSessionId() });
    await this.sessionController.sendSessionsList();

    // Send the plan as a prompt to the agent
    const implementPrompt = `Implement the following plan step by step. Follow the plan exactly and create all necessary files and changes.\n\n${planContent}`;
    await this.handleMessage(implementPrompt);
  }

  private async handleModelChange(modelName: string) {
    if (!modelName) return;
    this.state.currentModel = modelName;
    await vscode.workspace.getConfiguration('ollamaCopilot')
      .update('agentMode.model', modelName, vscode.ConfigurationTarget.Global);
  }

  private async handleSetSessionExplorerModel(model: string) {
    const sessionId = this.sessionController.getCurrentSessionId();
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { explorer_model: model || '' });
    // Update the in-memory session so getSessionExplorerModel() returns the new value
    const session = await this.sessionController.getCurrentSession();
    if (session) {
      session.explorer_model = model || '';
    }
  }

  // -------------------------------------------------------------------------
  // Slash command detection
  // -------------------------------------------------------------------------

  /** Supported slash commands and their target ExploreMode. */
  private static readonly SLASH_COMMANDS: Array<{ prefix: string; mode: ExploreMode }> = [
    { prefix: '/security-review', mode: 'review' },
    { prefix: '/review', mode: 'review' },
    { prefix: '/deep-explore', mode: 'deep-explore' },
  ];

  /**
   * Detect a slash command at the start of the message.
   * Returns the matching command or undefined.
   */
  private detectSlashCommand(text: string): { prefix: string; mode: ExploreMode } | undefined {
    const trimmed = text.trim().toLowerCase();
    return ChatMessageHandler.SLASH_COMMANDS.find(cmd => trimmed.startsWith(cmd.prefix));
  }

  /**
   * Extract the prompt from a slash command, preserving any context prefix.
   */
  private extractSlashPrompt(rawText: string, fullPrompt: string, commandPrefix: string): string {
    // Remove the slash command prefix from the raw text
    const stripped = rawText.trim().replace(new RegExp(`^${commandPrefix.replace('/', '\\/')}\\s*`, 'i'), '').trim();
    const defaultPrompts: Record<string, string> = {
      '/review': 'Perform a thorough security and quality review of the codebase.',
      '/security-review': 'Perform a thorough security and quality review of the codebase.',
      '/deep-explore': 'Perform a deep exploration of the provided code, tracing every function call to its source.',
    };
    const task = stripped || defaultPrompts[commandPrefix] || 'Explore the codebase.';

    // If fullPrompt has context prefix (from attached files), keep it
    if (fullPrompt.length > rawText.length) {
      const contextPrefix = fullPrompt.substring(0, fullPrompt.length - rawText.length);
      return contextPrefix + task;
    }
    return task;
  }
}
