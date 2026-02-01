import { readFile } from 'fs/promises';
import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { GitOperations } from '../agent/gitOperations';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { getConfig, getModeConfig } from '../config/settings';
import { AgentChatExecutor } from '../services/agentChatExecutor';
import { DatabaseService } from '../services/databaseService';
import { ModelManager } from '../services/modelManager';
import { OllamaClient } from '../services/ollamaClient';
import { TokenManager } from '../services/tokenManager';
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
      () => this.refreshExplorer()
    );

    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('ollamaCopilot')) {
        await this.settingsHandler.sendSettingsUpdate();
      }
    });
  }

  postMessage(message: any): void {
    this.view?.webview.postMessage(message);
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
          await this.initialize();
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
        case 'newChat':
          await this.sessionController.createNewSession(this.currentMode, this.currentModel);
          this.postMessage({ type: 'clearMessages', sessionId: this.sessionController.getCurrentSessionId() });
          await this.sessionController.sendSessionsList();
          break;
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
          await this.settingsHandler.testConnection();
          break;
        case 'saveBearerToken':
          await this.settingsHandler.saveBearerToken(data.token, data.testAfterSave);
          break;
        case 'searchSessions':
          await this.sessionController.handleSearchSessions(data.query);
          break;
        case 'loadMoreSessions':
          await this.sessionController.sendSessionsList(data.offset, true);
          break;
        case 'runDbMaintenance':
          await this.settingsHandler.runDbMaintenance();
          break;
      }
    });
  }

  private async initialize() {
    const settings = this.settingsHandler.getSettingsPayload();
    const hasToken = await this.tokenManager.hasToken();

    if (!this.sessionController.getCurrentSessionId()) {
      const recentSessions = await this.databaseService.listSessions(1);
      if (recentSessions.sessions.length > 0) {
        await this.sessionController.loadSession(recentSessions.sessions[0].id);
      } else {
        await this.sessionController.createNewSession(this.currentMode, this.currentModel);
      }
    }

    await this.sessionController.sendSessionsList();

    try {
      const models = await this.client.listModels();
      const modeConfig = getModeConfig('agent');
      this.currentModel = modeConfig.model || (models.length > 0 ? models[0].name : '');

      this.postMessage({
        type: 'init',
        models: models.map(m => ({ name: m.name, selected: m.name === this.currentModel })),
        currentMode: this.currentMode,
        settings,
        hasToken
      });
    } catch (error: any) {
      this.postMessage({
        type: 'init',
        models: [],
        currentMode: this.currentMode,
        settings,
        hasToken
      });

      this.postMessage({
        type: 'connectionError',
        error: error.message
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
        this.postMessage({
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
    const result = await this.agentExecutor.execute(agentSession, config, token, sessionId, this.currentModel);
    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(result.assistantMessage);
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

    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;
      if (chunk.message?.content) {
        fullResponse += chunk.message.content;
        this.postMessage({ type: 'streamChunk', content: fullResponse, model: this.currentModel, sessionId });
      }
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
