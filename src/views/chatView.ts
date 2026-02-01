import { readFile } from 'fs/promises';
import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { GitOperations } from '../agent/gitOperations';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { getConfig, getModeConfig } from '../config/settings';
import { DatabaseService } from '../services/databaseService';
import { ModelManager } from '../services/modelManager';
import { OllamaClient } from '../services/ollamaClient';
import { TokenManager } from '../services/tokenManager';
import { ChatSessionStatus, MessageRecord, SessionRecord } from '../types/session';
import { ChatMessage, ContextItem } from './chatTypes';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollamaCopilot.chatView';
  private view?: vscode.WebviewView;
  private currentSessionId: string = '';
  private currentSession: SessionRecord | null = null;
  private currentMessages: MessageRecord[] = [];
  private currentMode: string = 'agent';
  private currentModel: string = '';
  private cancellationTokenSource?: vscode.CancellationTokenSource;
  private activeSessions = new Map<string, vscode.CancellationTokenSource>();
  private configChangeDisposable?: vscode.Disposable;
  
  private toolRegistry: ToolRegistry;
  private gitOps: GitOperations;
  private outputChannel: vscode.OutputChannel;
  private databaseService: DatabaseService;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: OllamaClient,
    _modelManager: ModelManager,
    private readonly tokenManager: TokenManager,
    private readonly sessionManager: SessionManager,
    databaseService: DatabaseService
  ) {
    this.databaseService = databaseService;
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerBuiltInTools();
    this.outputChannel = vscode.window.createOutputChannel('Ollama Copilot Agent');
    this.gitOps = new GitOperations();
    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('ollamaCopilot')) {
        await this.sendSettingsUpdate();
      }
    });
  }

  private async createNewSession(): Promise<string> {
    const session = await this.databaseService.createSession(
      'New Chat',
      this.currentMode,
      this.currentModel
    );
    this.currentSessionId = session.id;
    this.currentSession = session;
    this.currentMessages = [];
    return session.id;
  }

  private async getCurrentSession(): Promise<SessionRecord | null> {
    if (this.currentSession && this.currentSession.id === this.currentSessionId) {
      return this.currentSession;
    }
    if (this.currentSessionId) {
      this.currentSession = await this.databaseService.getSession(this.currentSessionId);
      return this.currentSession;
    }
    return null;
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
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendSettingsUpdate();
        this.sendSessionsList();
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
          await this.initialize();
          await this.sendSettingsUpdate();
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
        case 'newChat':
          await this.createNewSession();
          this.view?.webview.postMessage({ type: 'clearMessages', sessionId: this.currentSessionId });
          await this.sendSessionsList();
          break;
        case 'addContext':
          await this.handleAddContext();
          break;
        case 'loadSession':
          await this.loadSession(data.sessionId);
          break;
        case 'deleteSession':
          await this.deleteSession(data.sessionId);
          break;
        case 'saveSettings':
          await this.saveSettings(data.settings);
          break;
        case 'testConnection':
          await this.testConnection();
          break;
        case 'saveBearerToken':
          await this.saveBearerToken(data.token, data.testAfterSave);
          break;
        case 'searchSessions':
          await this.handleSearchSessions(data.query);
          break;
        case 'loadMoreSessions':
          await this.sendSessionsList(data.offset, true);
          break;
        case 'runDbMaintenance':
          await this.runDbMaintenance();
          break;
      }
    });
  }

  private async initialize() {
    // Always send settings first, even before trying to connect
    const settings = this.getSettingsPayload();
    const hasToken = await this.tokenManager.hasToken();
    
    // Load most recent session if none selected, otherwise create a new one
    if (!this.currentSessionId) {
      const recentSessions = await this.databaseService.listSessions(1);
      if (recentSessions.sessions.length > 0) {
        await this.loadSession(recentSessions.sessions[0].id);
      } else {
        await this.createNewSession();
      }
    }
    
    // Always send sessions list first - this doesn't depend on Ollama connection
    await this.sendSessionsList();
    
    try {
      const models = await this.client.listModels();
      const modeConfig = getModeConfig('agent');
      this.currentModel = modeConfig.model || (models.length > 0 ? models[0].name : '');

      this.view?.webview.postMessage({
        type: 'init',
        models: models.map(m => ({ name: m.name, selected: m.name === this.currentModel })),
        currentMode: this.currentMode,
        settings,
        hasToken
      });
    } catch (error: any) {
      // Still send init with settings even if connection fails
      this.view?.webview.postMessage({
        type: 'init',
        models: [],
        currentMode: this.currentMode,
        settings,
        hasToken
      });
      
      this.view?.webview.postMessage({
        type: 'connectionError',
        error: error.message
      });
    }
  }

  private getSettingsPayload() {
    const config = getConfig();
    return {
      baseUrl: config.baseUrl,
      enableAutoComplete: vscode.workspace.getConfiguration('ollamaCopilot').get('enableAutoComplete', true),
      agentModel: config.agentMode.model,
      askModel: config.askMode.model,
      editModel: config.editMode.model,
      completionModel: config.completionMode.model,
      maxIterations: config.agent.maxIterations,
      toolTimeout: config.agent.toolTimeout,
      maxActiveSessions: config.agent.maxActiveSessions,
      temperature: config.agentMode.temperature
    };
  }

  private async sendSettingsUpdate() {
    if (!this.view) return;
    const settings = this.getSettingsPayload();
    this.client.setBaseUrl(settings.baseUrl);
    const hasToken = await this.tokenManager.hasToken();
    this.view.webview.postMessage({
      type: 'settingsUpdate',
      settings,
      hasToken
    });
  }

  private async sendSessionsList(offset = 0, append = false) {
    const sessionsPage = await this.databaseService.listSessions(50, offset);
    const sessionsList = sessionsPage.sessions.map(s => ({
      id: s.id,
      title: s.title,
      timestamp: s.updated_at,
      active: s.id === this.currentSessionId,
      status: s.status
    }));
    
    this.view?.webview.postMessage({
      type: append ? 'appendSessions' : 'loadSessions',
      sessions: sessionsList,
      hasMore: sessionsPage.hasMore,
      nextOffset: sessionsPage.nextOffset
    });
  }

  private async setSessionStatus(status: ChatSessionStatus, sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) return;
    await this.databaseService.updateSessionStatus(targetSessionId, status);
    if (this.currentSession && this.currentSession.id === targetSessionId) {
      this.currentSession = { ...this.currentSession, status, updated_at: Date.now() };
    }
    this.view?.webview.postMessage({
      type: 'updateSessionStatus',
      sessionId: targetSessionId,
      status
    });
  }

  private async runDbMaintenance() {
    try {
      const result = await this.databaseService.runMaintenance();
      this.view?.webview.postMessage({
        type: 'dbMaintenanceResult',
        success: true,
        deletedSessions: result.deletedSessions,
        deletedMessages: result.deletedMessages
      });
    } catch (error: any) {
      this.view?.webview.postMessage({
        type: 'dbMaintenanceResult',
        success: false,
        message: error?.message || 'Database maintenance failed.'
      });
    }
  }

  private async loadSession(sessionId: string) {
    const session = await this.databaseService.getSession(sessionId);
    if (!session) {
      this.view?.webview.postMessage({ type: 'clearMessages', sessionId });
      await this.sendSessionsList();
      return;
    }

    this.currentSessionId = sessionId;
    this.currentSession = session;
    try {
      this.currentMessages = await this.databaseService.getSessionMessages(sessionId);
    } catch (error: any) {
      this.view?.webview.postMessage({
        type: 'showError',
        message: error.message || 'Failed to load session.',
        sessionId
      });
      this.view?.webview.postMessage({ type: 'clearMessages' });
      await this.sendSessionsList();
      return;
    }
    
    // Convert to ChatMessage format for frontend
    const messages = this.currentMessages.map(m => {
      let actionText: string | undefined;
      let actionDetail: string | undefined;
      let actionIcon: string | undefined;
      let actionStatus: 'success' | 'error' | undefined;
      let toolArgs: any = undefined;

      if (m.tool_input) {
        try {
          toolArgs = JSON.parse(m.tool_input);
        } catch {
          toolArgs = undefined;
        }
      }

      if (m.role === 'tool' && m.tool_name) {
        const isError = (m.content || '').startsWith('Error:') || (m.tool_output || '').startsWith('Error:');
        actionStatus = isError ? 'error' : 'success';

        const { actionText: baseText, actionDetail: baseDetail, actionIcon: baseIcon } =
          this.getToolActionInfo(m.tool_name, toolArgs);

        actionText = baseText;
        actionIcon = baseIcon;
        actionDetail = baseDetail;

        if (!isError) {
          const { actionText: successText, actionDetail: successDetail } =
            this.getToolSuccessInfo(m.tool_name, toolArgs, m.tool_output || m.content || '');
          actionText = successText || actionText;
          actionDetail = successDetail || actionDetail;
        } else {
          actionDetail = (m.content || '').replace(/^Error:\s*/, '') || actionDetail;
        }
      }

      return {
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolName: m.tool_name,
        toolInput: m.tool_input,
        toolOutput: m.tool_output,
        progressTitle: m.progress_title,
        actionText,
        actionDetail,
        actionIcon,
        actionStatus,
        model: m.model
      };
    });
    
    this.view?.webview.postMessage({
      type: 'loadSessionMessages',
      messages,
      sessionId
    });
    if (session.status === 'generating' && this.activeSessions.has(sessionId)) {
      this.view?.webview.postMessage({ type: 'generationStarted', sessionId });
    } else {
      this.view?.webview.postMessage({ type: 'generationStopped', sessionId });
    }
    await this.sendSessionsList();
  }

  private async deleteSession(sessionId: string) {
    await this.databaseService.deleteSession(sessionId);
    if (sessionId === this.currentSessionId) {
      await this.createNewSession();
      this.view?.webview.postMessage({ type: 'clearMessages', sessionId: this.currentSessionId });
    }
    await this.sendSessionsList();
  }

  private async handleSearchSessions(query: string) {
    if (!query.trim()) {
      // Empty query - just show regular sessions list
      await this.sendSessionsList();
      return;
    }

    try {
      const results = await this.databaseService.searchHybrid(query, 50);
      
      // Group results by session
      const groupedResults: Map<string, {
        session: { id: string; title: string; timestamp: number };
        messages: Array<{ id: string; content: string; snippet: string; role: string }>;
      }> = new Map();

      for (const result of results) {
        if (result.message.role === 'tool') {
          continue;
        }
        if (!groupedResults.has(result.session.id)) {
          groupedResults.set(result.session.id, {
            session: {
              id: result.session.id,
              title: result.session.title,
              timestamp: result.session.updated_at
            },
            messages: []
          });
        }
        groupedResults.get(result.session.id)!.messages.push({
          id: result.message.id,
          content: result.message.content,
          snippet: result.snippet,
          role: result.message.role
        });
      }

      this.view?.webview.postMessage({
        type: 'searchSessionsResult',
        results: Array.from(groupedResults.values()),
        query
      });
    } catch (error) {
      console.error('Search failed:', error);
      this.view?.webview.postMessage({
        type: 'searchSessionsResult',
        results: [],
        query,
        error: 'Search failed'
      });
    }
  }

  private async saveSettings(settings: any) {
    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    
    if (settings.baseUrl !== undefined) {
      const inspect = config.inspect<string>('baseUrl');
      console.log('[OllamaCopilot] saveSettings - baseUrl value:', settings.baseUrl);
      console.log('[OllamaCopilot] saveSettings - inspect:', JSON.stringify(inspect));
      const target = inspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      console.log('[OllamaCopilot] saveSettings - target:', target === vscode.ConfigurationTarget.Workspace ? 'Workspace' : 'Global');
      await config.update('baseUrl', settings.baseUrl, target);
      console.log('[OllamaCopilot] saveSettings - update complete');
      this.client.setBaseUrl(settings.baseUrl);
    }
    if (settings.enableAutoComplete !== undefined) {
      await config.update('enableAutoComplete', settings.enableAutoComplete, vscode.ConfigurationTarget.Global);
    }
    if (settings.agentModel !== undefined) {
      await config.update('agentMode.model', settings.agentModel, vscode.ConfigurationTarget.Global);
    }
    if (settings.askModel !== undefined) {
      await config.update('askMode.model', settings.askModel, vscode.ConfigurationTarget.Global);
    }
    if (settings.editModel !== undefined) {
      await config.update('editMode.model', settings.editModel, vscode.ConfigurationTarget.Global);
    }
    if (settings.completionModel !== undefined) {
      await config.update('completionMode.model', settings.completionModel, vscode.ConfigurationTarget.Global);
    }
    if (settings.maxIterations !== undefined) {
      await config.update('agent.maxIterations', settings.maxIterations, vscode.ConfigurationTarget.Global);
    }
    if (settings.toolTimeout !== undefined) {
      await config.update('agent.toolTimeout', settings.toolTimeout, vscode.ConfigurationTarget.Global);
    }
    if (settings.maxActiveSessions !== undefined) {
      await config.update('agent.maxActiveSessions', settings.maxActiveSessions, vscode.ConfigurationTarget.Global);
    }
    
    this.view?.webview.postMessage({ type: 'settingsSaved' });
    await this.sendSettingsUpdate();
  }

  private async testConnection() {
    try {
      const models = await this.client.listModels();
      this.view?.webview.postMessage({
        type: 'connectionTestResult',
        success: true,
        message: 'Connected successfully!',
        models
      });
    } catch (error: any) {
      this.view?.webview.postMessage({
        type: 'connectionTestResult',
        success: false,
        message: error.message
      });
    }
  }

  private async saveBearerToken(token: string, testAfterSave?: boolean) {
    if (token) {
      await this.tokenManager.setToken(token);
      this.client.setBearerToken(token);
    } else {
      await this.tokenManager.deleteToken();
      this.client.setBearerToken(undefined);
    }
    this.view?.webview.postMessage({
      type: 'bearerTokenSaved',
      hasToken: !!token
    });
    
    // Test connection after token is saved if requested
    if (testAfterSave) {
      await this.testConnection();
    }
  }

  private async handleAddContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const fileName = editor.document.fileName.split('/').pop() || 'file';
      const lineInfo = selection.isEmpty ? '' : `:${selection.start.line + 1}`;
      
      this.view?.webview.postMessage({
        type: 'addContextItem',
        context: {
          fileName: fileName + lineInfo,
          content: text.substring(0, 8000)
        }
      });
    }
  }

  private stopGeneration(sessionId?: string) {
    const targetSessionId = sessionId || this.currentSessionId;
    const tokenSource = targetSessionId ? this.activeSessions.get(targetSessionId) : undefined;
    if (tokenSource) {
      tokenSource.cancel();
      this.activeSessions.delete(targetSessionId);
    }
    if (this.cancellationTokenSource === tokenSource) {
      this.cancellationTokenSource = undefined;
    }
    this.view?.webview.postMessage({ type: 'generationStopped', sessionId: targetSessionId });
    void this.setSessionStatus('completed', targetSessionId);
  }

  private async handleMessage(text: string, contextItems?: ContextItem[]) {
    if (!text.trim()) return;

    const session = await this.getCurrentSession();
    if (!session || !this.currentSessionId) return;

    const sessionIdAtStart = this.currentSessionId;
    const sessionMessagesSnapshot = [...this.currentMessages];
    const { agent } = getConfig();

    if (this.activeSessions.has(sessionIdAtStart)) {
      return;
    }

    if (this.activeSessions.size >= agent.maxActiveSessions) {
      this.view?.webview.postMessage({
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
    await this.setSessionStatus('generating', sessionIdAtStart);

    let contextStr = '';
    if (contextItems && contextItems.length > 0) {
      contextStr = contextItems.map(c => `[${c.fileName}]\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
    }

    const fullPrompt = contextStr ? `${contextStr}\n\n${text}` : text;

    // Add user message to database
    const userMessage = await this.databaseService.addMessage(
      sessionIdAtStart,
      'user',
      text
    );
    if (this.currentSessionId === sessionIdAtStart) {
      this.currentMessages.push(userMessage);
    }
    
    // Update session title if first message
    if (sessionMessagesSnapshot.length === 0) {
      const newTitle = text.substring(0, 40) + (text.length > 40 ? '...' : '');
      await this.databaseService.updateSession(sessionIdAtStart, { title: newTitle });
      await this.sendSessionsList();
    }
    
    const chatMessage: ChatMessage = { role: 'user', content: text, timestamp: userMessage.timestamp };
    this.view?.webview.postMessage({ type: 'addMessage', message: chatMessage, sessionId: sessionIdAtStart });
    this.view?.webview.postMessage({ type: 'generationStarted', sessionId: sessionIdAtStart });

    if (!this.currentModel) {
      await this.setSessionStatus('error', sessionIdAtStart);
      this.activeSessions.delete(sessionIdAtStart);
      this.view?.webview.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
      this.view?.webview.postMessage({ type: 'showError', message: 'No model selected', sessionId: sessionIdAtStart });
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
      this.view?.webview.postMessage({ type: 'showError', message: error.message, sessionId: sessionIdAtStart });
    } finally {
      await this.setSessionStatus(finalStatus, sessionIdAtStart);
      this.activeSessions.delete(sessionIdAtStart);
      this.view?.webview.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
    }
  }

  private async handleAgentMode(prompt: string, token: vscode.CancellationToken, sessionId: string) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.view?.webview.postMessage({ type: 'showError', message: 'No workspace folder open', sessionId });
      return;
    }

    const agentSession = this.sessionManager.createSession(prompt, this.currentModel, workspace);

    this.view?.webview.postMessage({ type: 'showThinking', message: 'Analyzing request...', sessionId });

    const hasGit = await this.gitOps.validateGit();
    if (hasGit) {
      try {
        const currentBranch = await this.gitOps.getCurrentBranch(workspace);
        const newBranch = await this.gitOps.createBranch(currentBranch, prompt, workspace);
        agentSession.branch = newBranch;
        this.view?.webview.postMessage({
          type: 'showToolAction',
          status: 'success',
          icon: '📌',
          text: `Created branch: ${newBranch}`,
          sessionId
        });
      } catch {
        // Continue without branch
      }
    }

    const config: ExecutorConfig = { maxIterations: 20, toolTimeout: 30000, temperature: 0.7 };
    await this.executeAgent(agentSession, config, token, sessionId);
  }

  private async executeAgent(
    agentSession: any,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    sessionId: string
  ) {
    const context = { workspace: agentSession.workspace, token, outputChannel: this.outputChannel };

    const messages: any[] = [
      { role: 'system', content: this.buildAgentSystemPrompt() },
      { role: 'user', content: agentSession.task }
    ];

    let iteration = 0;
    let accumulatedExplanation = '';

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      try {
        let response = '';
        const stream = this.client.chat({ model: this.currentModel, messages });

        this.view?.webview.postMessage({
          type: 'showThinking',
          message: iteration === 1 ? 'Thinking...' : 'Working...',
          sessionId
        });

        // Collect the full response first - don't stream partial content
        for await (const chunk of stream) {
          if (token.isCancellationRequested) break;
          if (chunk.message?.content) {
            response += chunk.message.content;
            
            // Only show what tool we're preparing to use
            const partialTool = this.detectPartialToolCall(response);
            if (partialTool) {
              this.view?.webview.postMessage({
                type: 'showThinking',
                message: `Preparing to use ${partialTool}...`,
                sessionId
              });
            }
          }
        }

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          break;
        }

        // Now that we have the full response, parse it
        const cleanedText = this.removeToolCalls(response);
        
        // Accumulate any explanatory text (not just overwrite)
        if (cleanedText.trim() && !cleanedText.includes('[TASK_COMPLETE]')) {
          if (accumulatedExplanation) {
            accumulatedExplanation += '\n\n';
          }
          accumulatedExplanation += cleanedText.trim();
          
          // Stream the cleaned response to the UI
          this.view?.webview.postMessage({
            type: 'streamChunk',
            content: accumulatedExplanation,
            model: this.currentModel,
            sessionId
          });
        }

        if (response.includes('[TASK_COMPLETE]') || response.toLowerCase().includes('task is complete')) {
          accumulatedExplanation = cleanedText.replace('[TASK_COMPLETE]', '').trim() || accumulatedExplanation;
          break;
        }

        const toolCalls = this.extractToolCalls(response);

        if (toolCalls.length === 0) {
          messages.push({ role: 'assistant', content: response });
          if (iteration < config.maxIterations - 1) {
            messages.push({ role: 'user', content: 'Continue with the task. Use tools or respond with [TASK_COMPLETE] if finished.' });
          }
          continue;
        }

        // Start a progress group for this batch of tool calls
        const groupTitle = this.getProgressGroupTitle(toolCalls);
        this.view?.webview.postMessage({
          type: 'startProgressGroup',
          title: groupTitle,
          sessionId
        });

        // Execute each tool call
        for (const toolCall of toolCalls) {
          if (token.isCancellationRequested) break;

          const { actionText, actionDetail, actionIcon } = this.getToolActionInfo(toolCall.name, toolCall.args);
          
          // Show pending/running state
          this.view?.webview.postMessage({
            type: 'showToolAction',
            status: 'running',
            icon: actionIcon,
            text: actionText,
            detail: actionDetail,
            sessionId
          });

          try {
            const result = await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            agentSession.toolCalls.push(result);

            if (['write_file', 'create_file', 'delete_file'].includes(toolCall.name)) {
              agentSession.filesChanged.push(toolCall.args?.path || toolCall.args?.file);
              this.refreshExplorer();
            }

            // Store tool execution in database
            if (sessionId) {
              await this.databaseService.addMessage(
                sessionId,
                'tool',
                result.output || '',
                {
                  model: this.currentModel,
                  toolName: toolCall.name,
                  toolInput: JSON.stringify(toolCall.args),
                  toolOutput: result.output,
                  progressTitle: groupTitle
                }
              );
            }

            // Show success state
            const { actionText: successText, actionDetail: successDetail } = this.getToolSuccessInfo(toolCall.name, toolCall.args, result.output);
            this.view?.webview.postMessage({
              type: 'showToolAction',
              status: 'success',
              icon: actionIcon,
              text: successText,
              detail: successDetail,
              sessionId
            });

            messages.push({ role: 'assistant', content: response });
            messages.push({ role: 'user', content: `Tool result for ${toolCall.name}:\n${result.output}\n\nContinue with the task.` });

          } catch (error: any) {
            // Show error state
            this.view?.webview.postMessage({
              type: 'showToolAction',
              status: 'error',
              icon: actionIcon,
              text: actionText,
              detail: error.message,
              sessionId
            });
            agentSession.errors.push(error.message);

            // Store failed tool execution in database
            if (sessionId) {
              await this.databaseService.addMessage(
                sessionId,
                'tool',
                `Error: ${error.message}`,
                {
                  model: this.currentModel,
                  toolName: toolCall.name,
                  toolInput: JSON.stringify(toolCall.args),
                  toolOutput: `Error: ${error.message}`,
                  progressTitle: groupTitle
                }
              );
            }

            messages.push({ role: 'assistant', content: response });
            messages.push({ role: 'user', content: `Tool ${toolCall.name} failed: ${error.message}\n\nTry a different approach.` });
          }
        }

      } catch (error: any) {
        this.view?.webview.postMessage({ type: 'showError', message: error.message, sessionId });
        break;
      }
    }

    // Finish the progress group
    this.view?.webview.postMessage({ type: 'finishProgressGroup', sessionId });
    this.sessionManager.updateSession(agentSession.id, { status: 'completed' });

    const filesChanged = agentSession.filesChanged?.length || 0;
    let summary = filesChanged > 0 ? `**${filesChanged} file${filesChanged > 1 ? 's' : ''} modified**\n\n` : '';
    const toolSummaryLines = (agentSession.toolCalls || [])
      .slice(-6)
      .map((tool: any) => {
        const toolName = tool.tool || tool.name || 'tool';
        const outputLine = (tool.output || '').toString().split('\n').filter(Boolean)[0] || '';
        const detail = tool.error ? `Error: ${tool.error}` : outputLine;
        return `- ${toolName}${detail ? `: ${detail}` : ''}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!accumulatedExplanation.trim()) {
      this.view?.webview.postMessage({ type: 'showThinking', message: 'Working...', sessionId });
      const toolResults = (agentSession.toolCalls || [])
        .slice(-6)
        .map((tool: any) => `Tool: ${tool.tool || tool.name}\nOutput:\n${(tool.output || '').toString().slice(0, 2000)}`)
        .join('\n\n');

      try {
        const finalStream = this.client.chat({
          model: this.currentModel,
          messages: [
            {
              role: 'system',
              content: 'You are a helpful coding assistant. Provide a concise final answer to the user based on tool results. Do not call tools.'
            },
            {
              role: 'user',
              content: `User request: ${agentSession.task}\n\nRecent tool results:\n${toolResults}\n\nProvide the final response now.`
            }
          ]
        });

        let finalResponse = '';
        for await (const chunk of finalStream) {
          if (chunk.message?.content) {
            finalResponse += chunk.message.content;
          }
        }

        accumulatedExplanation = finalResponse.trim();
      } catch {
        // fall back to default message if summarization fails
      }
      this.view?.webview.postMessage({ type: 'hideThinking', sessionId });
    }

    if (!accumulatedExplanation.trim() && toolSummaryLines) {
      accumulatedExplanation = `Summary of actions:\n${toolSummaryLines}`;
    }

    summary += accumulatedExplanation || 'Task completed successfully.';
    
    // Save assistant message to database
    const assistantMessage = await this.databaseService.addMessage(
      sessionId,
      'assistant',
      summary,
      { model: this.currentModel }
    );
    if (this.currentSessionId === sessionId) {
      this.currentMessages.push(assistantMessage);
    }
    
    this.view?.webview.postMessage({ type: 'finalMessage', content: summary, model: this.currentModel, sessionId });
    this.view?.webview.postMessage({ type: 'hideThinking', sessionId });
  }

  private getProgressGroupTitle(toolCalls: Array<{name: string, args: any}>): string {
    // Analyze tool calls to determine a good group title
    const hasRead = toolCalls.some(t => t.name === 'read_file');
    const hasWrite = toolCalls.some(t => t.name === 'write_file' || t.name === 'create_file');
    const hasSearch = toolCalls.some(t => t.name === 'search_workspace');
    const hasCommand = toolCalls.some(t => t.name === 'run_command');
    const hasListFiles = toolCalls.some(t => t.name === 'list_files');

    if (hasSearch) return 'Searching codebase';
    if (hasWrite && hasRead) return 'Modifying files';
    if (hasWrite) return 'Writing files';
    if (hasRead && toolCalls.length > 1) return 'Reading files';
    if (hasRead) return 'Analyzing code';
    if (hasListFiles) return 'Exploring workspace';
    if (hasCommand) return 'Running commands';
    return 'Executing task';
  }

  private getToolActionInfo(toolName: string, args: any): { actionText: string, actionDetail: string, actionIcon: string } {
    const path = args?.path || args?.file || '';
    const fileName = path ? path.split('/').pop() : '';
    
    switch (toolName) {
      case 'read_file':
        return {
          actionText: `Read ${fileName || 'file'}`,
          actionDetail: args?.startLine ? `lines ${args.startLine} to ${args.endLine || 'end'}` : '',
          actionIcon: '📄'
        };
      case 'write_file':
        return {
          actionText: `Write ${fileName || 'file'}`,
          actionDetail: '',
          actionIcon: '✏️'
        };
      case 'create_file':
        return {
          actionText: `Create ${fileName || 'file'}`,
          actionDetail: '',
          actionIcon: '📁'
        };
      case 'list_files':
        return {
          actionText: `List ${path || 'workspace'}`,
          actionDetail: '',
          actionIcon: '📋'
        };
      case 'search_workspace':
        return {
          actionText: `Search for "${args?.query || 'pattern'}"`,
          actionDetail: args?.filePattern ? `in ${args.filePattern}` : '',
          actionIcon: '🔍'
        };
      case 'run_command':
        return {
          actionText: `Run command`,
          actionDetail: (args?.command || '').substring(0, 30),
          actionIcon: '⚡'
        };
      default:
        return {
          actionText: toolName,
          actionDetail: '',
          actionIcon: '🔧'
        };
    }
  }

  private getToolSuccessInfo(toolName: string, args: any, output: string): { actionText: string, actionDetail: string } {
    const path = args?.path || args?.file || '';
    const fileName = path ? path.split('/').pop() : 'file';
    
    switch (toolName) {
      case 'read_file':
        const lines = output?.split('\n').length || 0;
        return {
          actionText: `Read ${fileName}`,
          actionDetail: `${lines} lines`
        };
      case 'write_file':
      case 'create_file':
        return {
          actionText: `Wrote ${fileName}`,
          actionDetail: ''
        };
      case 'list_files':
        const items = output?.split('\n').filter(Boolean).length || 0;
        return {
          actionText: `Listed ${path || 'workspace'}`,
          actionDetail: `${items} items`
        };
      case 'search_workspace':
        const matches = output?.split('\n').filter(Boolean).length || 0;
        return {
          actionText: `Searched "${args?.query || ''}"`,
          actionDetail: `${matches} results`
        };
      case 'run_command':
        return {
          actionText: 'Command completed',
          actionDetail: ''
        };
      default:
        return {
          actionText: toolName,
          actionDetail: 'completed'
        };
    }
  }

  private detectPartialToolCall(response: string): string | null {
    const match = response.match(/<tool_call>\s*\{\s*"name"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  }

  private removeToolCalls(response: string): string {
    return response
      // Remove <tool_call>...</tool_call> blocks
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      // Remove incomplete <tool_call> blocks (still being streamed)
      .replace(/<tool_call>[\s\S]*$/g, '')
      // Remove JSON function calls in code blocks
      .replace(/```json\s*\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?```/g, '')
      // Remove raw JSON with "name" and "arguments" (common tool call format)
      .replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
      // Remove [TASK_COMPLETE] marker
      .replace(/\[TASK_COMPLETE\]/g, '')
      .trim();
  }

  private extractToolCalls(response: string): Array<{name: string, args: any}> {
    const toolCalls: Array<{name: string, args: any}> = [];
    
    const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let match;
    
    while ((match = toolCallRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name && parsed.arguments) {
          toolCalls.push({ name: parsed.name, args: parsed.arguments });
        }
      } catch { /* skip */ }
    }

    return toolCalls;
  }

  private buildAgentSystemPrompt(): string {
    const tools = this.toolRegistry.getAll();
    return `You are an autonomous AI coding agent with tools.

AVAILABLE TOOLS:
${tools.map((t: { name: string; description: string }) => `- ${t.name}: ${t.description}`).join('\n')}

TO USE A TOOL:
<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>

RULES:
1. Read files before modifying
2. Write complete, working code
3. Use [TASK_COMPLETE] when done`;
  }

  private async handleChatMode(
    prompt: string,
    token: vscode.CancellationToken,
    sessionId: string,
    sessionMessages: MessageRecord[]
  ) {
    let fullResponse = '';
    
    // Build chat messages from current session messages
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
    
    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;
      if (chunk.message?.content) {
        fullResponse += chunk.message.content;
        this.view?.webview.postMessage({ type: 'streamChunk', content: fullResponse, model: this.currentModel, sessionId });
      }
    }

    // Save assistant message to database
    const assistantMessage = await this.databaseService.addMessage(
      sessionId,
      'assistant',
      fullResponse,
      { model: this.currentModel }
    );
    if (this.currentSessionId === sessionId) {
      this.currentMessages.push(assistantMessage);
    }
    
    this.view?.webview.postMessage({ type: 'finalMessage', content: fullResponse, model: this.currentModel, sessionId });
  }

  private async handleModelChange(modelName: string) {
    if (!modelName) return;
    this.currentModel = modelName;
    await vscode.workspace.getConfiguration('ollamaCopilot')
      .update('agentMode.model', modelName, vscode.ConfigurationTarget.Global);
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
      // Add cache buster to JS and CSS files
      if (value.endsWith('.js') || value.endsWith('.css')) {
        return `${attr}="${resourceUri.toString()}?v=${cacheBuster}"`;
      }
      return `${attr}="${resourceUri.toString()}"`;
    });
  }
}
