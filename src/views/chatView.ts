/**
 * THIN orchestrator — lifecycle + message routing only.
 * Do NOT add business logic here. Delegate to:
 *   - ChatSessionController (sessions, messages, list/search)
 *   - SettingsHandler (settings, tokens, connection, DB maintenance)
 *   - AgentChatExecutor (agent loop, tool calls, progress groups)
 */
import { readFile } from 'fs/promises';
import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { GitOperations } from '../agent/gitOperations';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { getConfig, getModeConfig } from '../config/settings';
import { AgentChatExecutor } from '../services/agentChatExecutor';
import { DatabaseService } from '../services/databaseService';
import { getModelCapabilities } from '../services/modelCompatibility';
import { ModelManager } from '../services/modelManager';
import { OllamaClient } from '../services/ollamaClient';
import { PendingEditDecorationProvider } from '../services/pendingEditDecorationProvider';
import { PendingEditReviewService } from '../services/pendingEditReviewService';
import { TerminalManager } from '../services/terminalManager';
import { TokenManager } from '../services/tokenManager';
import { Model } from '../types/ollama';
import { ChatSessionStatus, MessageRecord } from '../types/session';
import { ChatSessionController } from './chatSessionController';
import { ChatMessage, ContextItem, WebviewMessageEmitter } from './chatTypes';
import { SettingsHandler } from './settingsHandler';

export class ChatViewProvider implements vscode.WebviewViewProvider, WebviewMessageEmitter {
  public static readonly viewType = 'ollamaCopilot.chatView';
  private view?: vscode.WebviewView;
  private currentMode: string = 'agent';
  private currentModel: string = '';
  private cancellationTokenSource?: vscode.CancellationTokenSource;
  private activeSessions = new Map<string, vscode.CancellationTokenSource>();
  private configChangeDisposable?: vscode.Disposable;

  private toolRegistry: ToolRegistry;
  private gitOps: GitOperations;
  private outputChannel: vscode.OutputChannel;
  private databaseService: DatabaseService;

  private sessionController: ChatSessionController;
  private settingsHandler: SettingsHandler;
  private agentExecutor: AgentChatExecutor;
  private terminalManager: TerminalManager;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: OllamaClient,
    _modelManager: ModelManager,
    private readonly tokenManager: TokenManager,
    private readonly sessionManager: SessionManager,
    databaseService: DatabaseService,
    private readonly decorationProvider: PendingEditDecorationProvider,
    private readonly reviewService?: PendingEditReviewService
  ) {
    this.databaseService = databaseService;
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerBuiltInTools();
    this.outputChannel = vscode.window.createOutputChannel('Ollama Copilot Agent');
    this.gitOps = new GitOperations();
    this.terminalManager = new TerminalManager();

    this.sessionController = new ChatSessionController(
      this.databaseService,
      this,
      (sessionId: string) => this.activeSessions.has(sessionId)
    );
    this.settingsHandler = new SettingsHandler(this.client, this.tokenManager, this.databaseService, this);
    this.agentExecutor = new AgentChatExecutor(
      this.client,
      this.toolRegistry,
      this.databaseService,
      this.sessionManager,
      this.outputChannel,
      this,
      () => this.refreshExplorer(),
      this.terminalManager,
      this.decorationProvider
    );

    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('ollamaCopilot')) {
        await this.settingsHandler.sendSettingsUpdate();
      }
    });

    // Subscribe to review service file-resolved events → update DB + files-changed widget
    if (this.reviewService) {
      this.reviewService.onDidResolveFile(async (event) => {
        const sessionId = this.sessionController.getCurrentSessionId();

        // 1. Persist to database — the review service already reverted the file
        //    content (for undo), so we only need the DB status + decoration update.
        if (event.action === 'kept') {
          await this.agentExecutor.keepFile(event.checkpointId, event.filePath);
        } else {
          // File already reverted by review service — just update DB status + decoration + checkpoint
          await this.agentExecutor.markFileUndone(event.checkpointId, event.filePath);
        }

        // 2. Persist UI event BEFORE posting (CRITICAL RULE #1)
        const resultPayload = {
          checkpointId: event.checkpointId,
          filePath: event.filePath,
          action: event.action,
          success: true
        };
        await this.agentExecutor.persistUiEvent(sessionId, 'fileChangeResult', resultPayload);

        // 3. Update the webview widget
        this.postMessage({
          type: 'fileChangeResult',
          ...resultPayload,
          sessionId
        });

        // 4. Refresh diff stats for the whole checkpoint — file contents changed
        try {
          const stats = await this.agentExecutor.computeFilesDiffStats(event.checkpointId);
          this.postMessage({ type: 'filesDiffStats', checkpointId: event.checkpointId, files: stats });
        } catch { /* non-critical */ }
      });

      // Subscribe to hunk-level stats updates → sync widget per-file stats in real-time
      this.reviewService.onDidUpdateHunkStats((event) => {
        this.postMessage({
          type: 'filesDiffStats',
          checkpointId: event.checkpointId,
          files: [{ path: event.filePath, additions: event.additions, deletions: event.deletions }]
        });
      });
    }
  }

  postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Reveal the sidebar and navigate the webview to the settings page.
   * Called by the `ollamaCopilot.showSetup` command and on first-run.
   */
  public navigateToSettings(isFirstRun = false) {
    if (this.view) {
      this.view.show?.(true);
      this.postMessage({ type: 'navigateToSettings', isFirstRun });
    } else {
      // Sidebar hasn't been resolved yet — reveal the view which will
      // trigger resolveWebviewView, then queue the navigation.
      vscode.commands.executeCommand('ollamaCopilot.chatView.focus').then(() => {
        // Small delay to let the webview finish initializing
        setTimeout(() => {
          this.postMessage({ type: 'navigateToSettings', isFirstRun });
        }, 500);
      });
    }
  }

  private refreshExplorer() {
    vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;

    webviewView.onDidDispose(() => {
      this.configChangeDisposable?.dispose();
      this.configChangeDisposable = undefined;
      this.terminalManager.dispose();
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.settingsHandler.sendSettingsUpdate();
        this.sessionController.sendSessionsList();
      }
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };

    webviewView.webview.html = await this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async data => {
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
        case 'selectMode':
          this.currentMode = data.mode;
          break;
        case 'newChat': {
          const idleSessionId = await this.databaseService.findIdleEmptySession();
          if (idleSessionId) {
            await this.sessionController.loadSession(idleSessionId);
          } else {
            await this.sessionController.createNewSession(this.currentMode, this.currentModel);
            this.postMessage({ type: 'clearMessages', sessionId: this.sessionController.getCurrentSessionId() });
            this.postMessage({
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
        case 'loadSession':
          await this.sessionController.loadSession(data.sessionId);
          break;
        case 'deleteSession':
          await this.sessionController.deleteSession(data.sessionId, this.currentMode, this.currentModel);
          break;
        case 'saveSettings':
          await this.settingsHandler.saveSettings(data.settings);
          break;
        case 'testConnection':
          await this.settingsHandler.testConnection(data.baseUrl);
          break;
        case 'saveBearerToken':
          await this.settingsHandler.saveBearerToken(data.token, data.testAfterSave, data.baseUrl);
          break;
        case 'deleteMultipleSessions': {
          const ids: string[] = data.sessionIds || [];
          if (ids.length === 0) break;
          const confirm = await vscode.window.showWarningMessage(
            `Delete ${ids.length} conversation${ids.length > 1 ? 's' : ''}? This cannot be undone.`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') {
            await this.sessionController.deleteMultipleSessions(ids, this.currentMode, this.currentModel);
          } else {
            // Cancelled — tell frontend to undo optimistic removal
            this.postMessage({ type: 'sessionsDeleted', sessionIds: [] });
            await this.sessionController.sendSessionsList();
          }
          break;
        }
        case 'searchSessions':
          await this.sessionController.handleSearchSessions(data.query);
          break;
        case 'loadMoreSessions':
          await this.sessionController.sendSessionsList(data.offset, true);
          break;
        case 'runDbMaintenance':
          await this.settingsHandler.runDbMaintenance();
          break;
        case 'recreateMessagesTable':
          await this.settingsHandler.recreateMessagesTable();
          break;
        case 'toolApprovalResponse':
          this.agentExecutor.handleToolApprovalResponse(data.approvalId, !!data.approved, data.command);
          break;
        case 'setAutoApprove':
          await this.handleSetAutoApprove(data.sessionId, !!data.enabled);
          break;
        case 'setAutoApproveSensitiveEdits':
          await this.handleSetAutoApproveSensitiveEdits(data.sessionId, !!data.enabled);
          break;
        case 'updateSessionSensitivePatterns':
          await this.handleUpdateSessionSensitivePatterns(data.sessionId, data.patterns);
          break;
        case 'openFileDiff':
          await this.agentExecutor.openFileDiff(data.approvalId);
          break;
        case 'openFileChangeDiff':
          await this.agentExecutor.openSnapshotDiff(data.checkpointId, data.filePath, this.sessionController.getCurrentSessionId());
          break;
        case 'openFileChangeReview':
          if (this.reviewService) {
            await this.reviewService.openFileReview(data.checkpointId, data.filePath, this.sessionController.getCurrentSessionId());
            const pos = this.reviewService.getChangePosition(data.checkpointId);
            if (pos) {
              this.postMessage({ type: 'reviewChangePosition', checkpointId: data.checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
            }
          } else {
            await this.agentExecutor.openSnapshotDiff(data.checkpointId, data.filePath, this.sessionController.getCurrentSessionId());
          }
          break;
        case 'requestFilesDiffStats':
          await this.handleRequestFilesDiffStats(data.checkpointId);
          break;
        case 'keepFile':
          await this.handleKeepFile(data.checkpointId, data.filePath, data.sessionId);
          break;
        case 'undoFile':
          await this.handleUndoFile(data.checkpointId, data.filePath, data.sessionId);
          break;
        case 'keepAllChanges':
          await this.handleKeepAllChanges(data.checkpointId, data.sessionId);
          break;
        case 'undoAllChanges':
          await this.handleUndoAllChanges(data.checkpointId, data.sessionId);
          break;
        case 'navigateReviewPrev': {
          try {
            const ids = data.checkpointIds || (data.checkpointId ? [data.checkpointId] : []);
            const pos = await this.reviewService?.navigateChange('prev', ids);
            if (pos) { this.postMessage({ type: 'reviewChangePosition', checkpointId: ids[0], current: pos.current, total: pos.total, filePath: pos.filePath }); }
          } catch (err: any) { console.error('[ChatView] navigateReviewPrev failed:', err); }
          break;
        }
        case 'navigateReviewNext': {
          try {
            const ids = data.checkpointIds || (data.checkpointId ? [data.checkpointId] : []);
            const pos = await this.reviewService?.navigateChange('next', ids);
            if (pos) { this.postMessage({ type: 'reviewChangePosition', checkpointId: ids[0], current: pos.current, total: pos.total, filePath: pos.filePath }); }
          } catch (err: any) { console.error('[ChatView] navigateReviewNext failed:', err); }
          break;
        }
        case 'refreshCapabilities':
          this.handleRefreshCapabilities(/* onlyMissing */ false);
          break;
        case 'toggleModelEnabled':
          await this.handleToggleModelEnabled(data.modelName, !!data.enabled);
          break;
      }
    });
  }

  private async handleSetAutoApprove(sessionId: string, enabled: boolean) {
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { auto_approve_commands: enabled });
    await this.sessionController.updateSessionAutoApprove(sessionId, enabled);
    this.postMessage({
      type: 'sessionApprovalSettings',
      sessionId,
      autoApproveCommands: enabled
    });
  }

  private async handleSetAutoApproveSensitiveEdits(sessionId: string, enabled: boolean) {
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { auto_approve_sensitive_edits: enabled });
    await this.sessionController.updateSessionAutoApproveSensitiveEdits(sessionId, enabled);
    this.postMessage({
      type: 'sessionApprovalSettings',
      sessionId,
      autoApproveSensitiveEdits: enabled
    });
  }

  private async handleUpdateSessionSensitivePatterns(sessionId: string, patterns: string | null) {
    if (!sessionId) return;
    await this.databaseService.updateSession(sessionId, { sensitive_file_patterns: patterns });
    await this.sessionController.updateSessionSensitiveFilePatterns(sessionId, patterns);
    this.postMessage({
      type: 'sessionApprovalSettings',
      sessionId,
      sessionSensitiveFilePatterns: patterns
    });
  }

  /**
   * Merge capabilities and enabled state from SQLite cache into freshly-listed models.
   * This avoids showing blank capabilities before /api/show runs.
   */
  private async mergeCachedCapabilities(models: Model[]): Promise<void> {
    try {
      const cached = await this.databaseService.getCachedModels();
      const cacheMap = new Map(cached.map(m => [m.name, m]));
      for (const model of models) {
        const c = cacheMap.get(model.name);
        if (c) {
          if (!model.capabilities && c.capabilities) model.capabilities = c.capabilities;
          if (model.enabled === undefined && c.enabled !== undefined) model.enabled = c.enabled;
        }
      }
    } catch { /* ignore cache errors */ }
  }

  /**
   * Toggle a model's enabled state and notify the webview.
   */
  private async handleToggleModelEnabled(modelName: string, enabled: boolean) {
    if (!modelName) return;
    await this.databaseService.setModelEnabled(modelName, enabled);
    // Send updated modelInfo to the webview
    let models: Model[];
    try {
      models = await this.databaseService.getCachedModels();
    } catch {
      return;
    }
    const enriched = models.map(m => {
      const caps = getModelCapabilities(m);
      return {
        name: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size ?? undefined,
        quantizationLevel: m.details?.quantization_level ?? undefined,
        capabilities: caps,
        enabled: m.enabled !== false
      };
    });
    this.postMessage({ type: 'modelEnabledChanged', models: enriched });
  }

  private capabilityRefreshInProgress = false;

  /**
   * Background capability refresh: calls /api/show for models sequentially.
   * @param onlyMissing If true, skip models that already have cached capabilities.
   */
  private async handleRefreshCapabilities(onlyMissing = false) {
    if (this.capabilityRefreshInProgress) return;
    this.capabilityRefreshInProgress = true;

    try {
      let models: Model[];
      try {
        models = await this.client.listModels();
        // Merge cached capabilities so we know which ones already have data
        await this.mergeCachedCapabilities(models);
      } catch {
        // Fall back to cached models
        try { models = await this.databaseService.getCachedModels(); } catch { models = []; }
      }

      // Determine which models need /api/show
      const indicesToFetch = models
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !onlyMissing || !m.capabilities)
        .map(({ i }) => i);

      if (indicesToFetch.length === 0) {
        // Nothing to fetch — send current state and finish
        this.postMessage({ type: 'capabilityCheckComplete' });
        return;
      }

      const total = indicesToFetch.length;
      this.postMessage({ type: 'capabilityCheckProgress', completed: 0, total });

      for (let step = 0; step < indicesToFetch.length; step++) {
        const i = indicesToFetch[step];
        try {
          const showResult = await this.client.showModel(models[i].name);
          if (showResult.capabilities) {
            models[i].capabilities = showResult.capabilities;
          }
        } catch {
          // On error (401, network, etc.), keep existing cached capabilities
        }

        // Send progress update with enriched models so far
        this.postMessage({
          type: 'capabilityCheckProgress',
          completed: step + 1,
          total,
          models: models.map(m => {
            const caps = getModelCapabilities(m);
            return {
              name: m.name,
              size: m.size,
              parameterSize: m.details?.parameter_size ?? undefined,
              quantizationLevel: m.details?.quantization_level ?? undefined,
              capabilities: caps,
              enabled: m.enabled !== false
            };
          })
        });
      }

      // Persist fully enriched models to SQLite
      this.databaseService.upsertModels(models).catch(err =>
        console.warn('[ChatView] Failed to cache models after capability refresh:', err)
      );

      this.postMessage({ type: 'capabilityCheckComplete' });
    } catch (error: any) {
      console.warn('[ChatView] Capability refresh failed:', error);
      this.postMessage({ type: 'capabilityCheckComplete' });
    } finally {
      this.capabilityRefreshInProgress = false;
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
          await this.sessionController.createNewSession(this.currentMode, this.currentModel);
        }
      }
    })();

    const modelListPromise = (async () => {
      try {
        const fetched = await this.client.listModels();
        // Merge capabilities from SQLite cache so the UI isn't blank
        await this.mergeCachedCapabilities(fetched);
        // Persist basic model info (fire-and-forget)
        this.databaseService.upsertModels(fetched).catch(err =>
          console.warn('[ChatView] Failed to cache models:', err)
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
    this.currentModel = modeConfig.model || (models.length > 0 ? models[0].name : '');

    this.postMessage({
      type: 'init',
      models: models.map((m: any) => {
        const caps = getModelCapabilities(m);
        return {
          name: m.name,
          selected: m.name === this.currentModel,
          size: m.size ?? 0,
          parameterSize: m.details?.parameter_size ?? undefined,
          quantizationLevel: m.details?.quantization_level ?? undefined,
          capabilities: caps,
          enabled: m.enabled !== false
        };
      }),
      currentMode: this.currentMode,
      settings,
      hasToken
    });

    // Populate the sessions list for the sidebar
    await this.sessionController.sendSessionsList();

    // Auto-pull capabilities in background for models that don't have them yet
    if (models.length > 0) {
      this.handleRefreshCapabilities(/* onlyMissing */ true);
    }

    if (models.length === 0) {
      this.postMessage({
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
      const fileName = editor.document.fileName.split('/').pop() || 'file';
      const lineInfo = selection.isEmpty ? '' : `:${selection.start.line + 1}`;

      this.postMessage({
        type: 'addContextItem',
        context: {
          fileName: fileName + lineInfo,
          content: text.substring(0, 8000)
        }
      });
    }
  }

  private stopGeneration(sessionId?: string) {
    const targetSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const tokenSource = targetSessionId ? this.activeSessions.get(targetSessionId) : undefined;
    if (tokenSource) {
      tokenSource.cancel();
      this.activeSessions.delete(targetSessionId);
    }
    if (this.cancellationTokenSource === tokenSource) {
      this.cancellationTokenSource = undefined;
    }
    this.postMessage({ type: 'generationStopped', sessionId: targetSessionId });
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
      mode: this.currentMode
    });

    const sessionMessagesSnapshot = [...this.sessionController.getCurrentMessages()];
    const { agent } = getConfig();

    if (this.activeSessions.has(sessionIdAtStart)) {
      return;
    }

    if (this.activeSessions.size >= agent.maxActiveSessions) {
      this.postMessage({
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
    this.activeSessions.set(sessionIdAtStart, tokenSource);
    const token = tokenSource.token;
    await this.sessionController.setSessionStatus('generating', sessionIdAtStart);

    let contextStr = '';
    if (contextItems && contextItems.length > 0) {
      contextStr = contextItems.map(c => `[${c.fileName}]\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
    }

    const fullPrompt = contextStr ? `${contextStr}\n\n${text}` : text;

    console.log('Persisting user message to database:', { sessionId: sessionIdAtStart });
    const userMessage = await this.databaseService.addMessage(sessionIdAtStart, 'user', text);
    if (this.sessionController.getCurrentSessionId() === sessionIdAtStart) {
      this.sessionController.pushMessage(userMessage);
    }

    if (sessionMessagesSnapshot.length === 0) {
      const newTitle = text.substring(0, 40) + (text.length > 40 ? '...' : '');
      await this.databaseService.updateSession(sessionIdAtStart, { title: newTitle });
      await this.sessionController.sendSessionsList();
    }

    const chatMessage: ChatMessage = { role: 'user', content: text, timestamp: userMessage.timestamp };
    this.postMessage({ type: 'addMessage', message: chatMessage, sessionId: sessionIdAtStart });
    this.postMessage({ type: 'generationStarted', sessionId: sessionIdAtStart });

    if (!this.currentModel) {
      await this.sessionController.setSessionStatus('error', sessionIdAtStart);
      this.activeSessions.delete(sessionIdAtStart);
      this.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
      this.postMessage({ type: 'showError', message: 'No model selected', sessionId: sessionIdAtStart });
      return;
    }

    let finalStatus: ChatSessionStatus = 'completed';
    try {
      if (this.currentMode === 'agent') {
        await this.handleAgentMode(fullPrompt, token, sessionIdAtStart);
      } else {
        await this.handleChatMode(fullPrompt, token, sessionIdAtStart, sessionMessagesSnapshot);
      }
    } catch (error: any) {
      finalStatus = 'error';
      this.postMessage({ type: 'showError', message: error.message, sessionId: sessionIdAtStart });
    } finally {
      await this.sessionController.setSessionStatus(finalStatus, sessionIdAtStart);
      this.activeSessions.delete(sessionIdAtStart);
      this.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
    }
  }

  private async handleAgentMode(prompt: string, token: vscode.CancellationToken, sessionId: string) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.postMessage({ type: 'showError', message: 'No workspace folder open', sessionId });
      return;
    }

    const agentSession = this.sessionManager.createSession(prompt, this.currentModel, workspace);

    this.postMessage({ type: 'showThinking', message: 'Analyzing request...', sessionId });

    const hasGit = await this.gitOps.validateGit();
    if (hasGit) {
      try {
        const currentBranch = await this.gitOps.getCurrentBranch(workspace);
        const newBranch = await this.gitOps.createBranch(currentBranch, prompt, workspace);
        agentSession.branch = newBranch;

        // Persist git branch action so history matches live chat
        await this.agentExecutor.persistGitBranchAction(sessionId, newBranch);
      } catch {
        // Continue without branch
      }
    }

    const config: ExecutorConfig = { maxIterations: getConfig().agent.maxIterations, toolTimeout: getConfig().agent.toolTimeout, temperature: 0.7 };

    // Fetch model capabilities to decide native vs XML tool calling
    let capabilities: import('../services/modelCompatibility').ModelCapabilities | undefined;
    try {
      const cached = await this.databaseService.getCachedModels();
      const modelRecord = cached.find(m => m.name === this.currentModel);
      if (modelRecord) {
        capabilities = getModelCapabilities(modelRecord);
      }
    } catch { /* proceed without — executor will default to XML fallback */ }

    const result = await this.agentExecutor.execute(agentSession, config, token, sessionId, this.currentModel, capabilities);
    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(result.assistantMessage);
    }

    // Auto-start inline review for any already-open editors
    if (result.checkpointId && this.reviewService) {
      await this.reviewService.startReviewForCheckpoint(result.checkpointId);
      const pos = this.reviewService.getChangePosition(result.checkpointId);
      if (pos) {
        this.postMessage({ type: 'reviewChangePosition', checkpointId: result.checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
      }
    }
  }

  private async handleChatMode(
    prompt: string,
    token: vscode.CancellationToken,
    sessionId: string,
    sessionMessages: MessageRecord[]
  ) {
    let fullResponse = '';

    const chatMessages = sessionMessages
      .filter(m => m.role !== 'tool')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const systemPrompt = this.currentMode === 'edit'
      ? 'You are a code editor. Provide clear, concise code modifications.'
      : 'You are a helpful coding assistant.';

    const stream = this.client.chat({
      model: this.currentModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...chatMessages,
        { role: 'user', content: prompt }
      ]
    });

    // Show thinking spinner until first token arrives
    this.postMessage({ type: 'showThinking', message: 'Thinking...', sessionId });
    let firstChunk = true;

    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    const STREAM_THROTTLE_MS = 32; // ~30fps — balances responsiveness with CPU usage

    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;
      if (chunk.message?.content) {
        fullResponse += chunk.message.content;
        if (firstChunk) {
          firstChunk = false;
          this.postMessage({ type: 'hideThinking', sessionId });
        }
        // Throttle: schedule a trailing-edge post instead of posting every token
        if (!streamTimer) {
          streamTimer = setTimeout(() => {
            streamTimer = null;
            this.postMessage({ type: 'streamChunk', content: fullResponse, model: this.currentModel, sessionId });
          }, STREAM_THROTTLE_MS);
        }
      }
    }

    // Flush any pending throttled update
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }

    const assistantMessage = await this.databaseService.addMessage(
      sessionId,
      'assistant',
      fullResponse,
      { model: this.currentModel }
    );
    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(assistantMessage);
    }

    this.postMessage({ type: 'finalMessage', content: fullResponse, model: this.currentModel, sessionId });
  }

  private async handleModelChange(modelName: string) {
    if (!modelName) return;
    this.currentModel = modelName;
    await vscode.workspace.getConfiguration('ollamaCopilot')
      .update('agentMode.model', modelName, vscode.ConfigurationTarget.Global);
  }

  // ---------------------------------------------------------------------------
  // Files Changed handlers
  // ---------------------------------------------------------------------------

  private async handleRequestFilesDiffStats(checkpointId: string) {
    if (!checkpointId) return;
    try {
      const stats = await this.agentExecutor.computeFilesDiffStats(checkpointId);
      this.postMessage({ type: 'filesDiffStats', checkpointId, files: stats });
    } catch (err: any) {
      console.warn('[ChatView] Failed to compute diff stats:', err);
    }
    // Send change position — build review session if needed so the
    // "Change X of Y" counter is populated on first load.
    if (this.reviewService) {
      try {
        await this.reviewService.startReviewForCheckpoint(checkpointId);
        const pos = this.reviewService.getChangePosition(checkpointId);
        if (pos) {
          this.postMessage({ type: 'reviewChangePosition', checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
        }
      } catch { /* non-critical — navigation still works on click */ }
    }
  }

  private async handleKeepFile(checkpointId: string, filePath: string, sessionId?: string) {
    if (!checkpointId || !filePath) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.keepFile(checkpointId, filePath);
    this.reviewService?.removeFileFromReview(filePath);
    const payload = { checkpointId, filePath, action: 'kept', success: result.success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'fileChangeResult', payload);
    this.postMessage({ type: 'fileChangeResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleUndoFile(checkpointId: string, filePath: string, sessionId?: string) {
    if (!checkpointId || !filePath) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.undoFile(checkpointId, filePath);
    this.reviewService?.removeFileFromReview(filePath);
    const payload = { checkpointId, filePath, action: 'undone', success: result.success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'fileChangeResult', payload);
    this.postMessage({ type: 'fileChangeResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleKeepAllChanges(checkpointId: string, sessionId?: string) {
    if (!checkpointId) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.keepAllChanges(checkpointId);
    this.reviewService?.closeReview();
    const payload = { checkpointId, action: 'kept', success: result.success };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'keepUndoResult', payload);
    this.postMessage({ type: 'keepUndoResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async handleUndoAllChanges(checkpointId: string, sessionId?: string) {
    if (!checkpointId) return;
    const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const result = await this.agentExecutor.undoAllChanges(checkpointId);
    this.reviewService?.closeReview();
    const payload = { checkpointId, action: 'undone', success: result.success, errors: result.errors };
    await this.agentExecutor.persistUiEvent(resolvedSessionId, 'keepUndoResult', payload);
    this.postMessage({ type: 'keepUndoResult', ...payload, sessionId: resolvedSessionId });
    await this.sessionController.sendSessionsList();
  }

  private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'index.html');
    const html = await readFile(htmlPath.fsPath, 'utf8');
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const cacheBuster = Date.now();

    return html.replace(/(src|href)="([^"]+)"/g, (match, attr, value) => {
      if (value.startsWith('http') || value.startsWith('data:') || value.startsWith('#')) {
        return match;
      }
      const resourcePath = value.replace(/^\//, '');
      const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, resourcePath));
      if (value.endsWith('.js') || value.endsWith('.css')) {
        return `${attr}="${resourceUri.toString()}?v=${cacheBuster}"`;
      }
      return `${attr}="${resourceUri.toString()}"`;
    });
  }
}
