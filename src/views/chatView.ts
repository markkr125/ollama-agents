import { readFile } from 'fs/promises';
import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { GitOperations } from '../agent/gitOperations';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { getConfig, getModeConfig } from '../config/settings';
import { HistoryManager } from '../services/historyManager';
import { ModelManager } from '../services/modelManager';
import { OllamaClient } from '../services/ollamaClient';
import { TokenManager } from '../services/tokenManager';
import { ChatMessage, ChatSession, ContextItem } from './chatTypes';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollamaCopilot.chatView';
  private view?: vscode.WebviewView;
  private sessions: Map<string, ChatSession> = new Map();
  private currentSessionId: string = '';
  private currentMode: string = 'agent';
  private currentModel: string = '';
  private isGenerating = false;
  private cancellationTokenSource?: vscode.CancellationTokenSource;
  private configChangeDisposable?: vscode.Disposable;
  
  private toolRegistry: ToolRegistry;
  private gitOps: GitOperations;
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: OllamaClient,
    _modelManager: ModelManager,
    _historyManager: HistoryManager,
    private readonly tokenManager: TokenManager,
    private readonly sessionManager: SessionManager
  ) {
    this.createNewSession();
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

  private createNewSession(): string {
    const id = `session_${Date.now()}`;
    const session: ChatSession = {
      id,
      title: 'New Chat',
      messages: [],
      mode: this.currentMode,
      model: this.currentModel,
      timestamp: Date.now()
    };
    this.sessions.set(id, session);
    this.currentSessionId = id;
    return id;
  }

  private getCurrentSession(): ChatSession | undefined {
    return this.sessions.get(this.currentSessionId);
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
      }
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };

    webviewView.webview.html = await this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async data => {
      console.log('[OllamaCopilot] Received message from webview:', data.type);
      switch (data.type) {
        case 'ready':
          console.log('[OllamaCopilot] Webview ready, calling initialize()');
          await this.initialize();
          await this.sendSettingsUpdate();
          break;
        case 'sendMessage':
          await this.handleMessage(data.text, data.context);
          break;
        case 'stopGeneration':
          this.stopGeneration();
          break;
        case 'selectModel':
          await this.handleModelChange(data.model);
          break;
        case 'selectMode':
          this.currentMode = data.mode;
          break;
        case 'newChat':
          this.createNewSession();
          this.view?.webview.postMessage({ type: 'clearMessages' });
          this.sendSessionsList();
          break;
        case 'addContext':
          await this.handleAddContext();
          break;
        case 'loadSession':
          this.loadSession(data.sessionId);
          break;
        case 'deleteSession':
          this.deleteSession(data.sessionId);
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
      }
    });
  }

  private async initialize() {
    // Always send settings first, even before trying to connect
    const settings = this.getSettingsPayload();
    const hasToken = await this.tokenManager.hasToken();
    
    console.log('[OllamaCopilot] initialize() - sending init message with settings:', JSON.stringify(settings));
    
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

      this.sendSessionsList();
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
    console.log('[OllamaCopilot] getSettingsPayload - baseUrl from config:', config.baseUrl);
    return {
      baseUrl: config.baseUrl,
      enableAutoComplete: vscode.workspace.getConfiguration('ollamaCopilot').get('enableAutoComplete', true),
      agentModel: config.agentMode.model,
      askModel: config.askMode.model,
      editModel: config.editMode.model,
      completionModel: config.completionMode.model,
      maxIterations: config.agent.maxIterations,
      toolTimeout: config.agent.toolTimeout,
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

  private sendSessionsList() {
    const sessionsList = Array.from(this.sessions.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(s => ({
        id: s.id,
        title: s.title,
        timestamp: s.timestamp,
        active: s.id === this.currentSessionId
      }));
    
    this.view?.webview.postMessage({
      type: 'loadSessions',
      sessions: sessionsList
    });
  }

  private loadSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.currentSessionId = sessionId;
      this.view?.webview.postMessage({
        type: 'loadSessionMessages',
        messages: session.messages
      });
      this.sendSessionsList();
    }
  }

  private deleteSession(sessionId: string) {
    this.sessions.delete(sessionId);
    if (sessionId === this.currentSessionId) {
      this.createNewSession();
      this.view?.webview.postMessage({ type: 'clearMessages' });
    }
    this.sendSessionsList();
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

  private stopGeneration() {
    if (this.cancellationTokenSource) {
      this.cancellationTokenSource.cancel();
      this.cancellationTokenSource = undefined;
    }
    this.isGenerating = false;
    this.view?.webview.postMessage({ type: 'generationStopped' });
  }

  private async handleMessage(text: string, contextItems?: ContextItem[]) {
    if (!text.trim() || this.isGenerating) return;

    const session = this.getCurrentSession();
    if (!session) return;

    this.cancellationTokenSource = new vscode.CancellationTokenSource();
    const token = this.cancellationTokenSource.token;
    this.isGenerating = true;

    let contextStr = '';
    if (contextItems && contextItems.length > 0) {
      contextStr = contextItems.map(c => `[${c.fileName}]\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
    }

    const fullPrompt = contextStr ? `${contextStr}\n\n${text}` : text;

    const userMessage: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
    session.messages.push(userMessage);
    
    if (session.messages.length === 1) {
      session.title = text.substring(0, 40) + (text.length > 40 ? '...' : '');
      this.sendSessionsList();
    }
    
    this.view?.webview.postMessage({ type: 'addMessage', message: userMessage });
    this.view?.webview.postMessage({ type: 'generationStarted' });

    if (!this.currentModel) {
      this.view?.webview.postMessage({ type: 'generationStopped' });
      this.isGenerating = false;
      this.view?.webview.postMessage({ type: 'showError', message: 'No model selected' });
      return;
    }

    try {
      if (this.currentMode === 'agent') {
        await this.handleAgentMode(session, fullPrompt, token);
      } else {
        await this.handleChatMode(session, fullPrompt, token);
      }
    } catch (error: any) {
      this.view?.webview.postMessage({ type: 'showError', message: error.message });
    } finally {
      this.isGenerating = false;
      this.view?.webview.postMessage({ type: 'generationStopped' });
    }
  }

  private async handleAgentMode(chatSession: ChatSession, prompt: string, token: vscode.CancellationToken) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.view?.webview.postMessage({ type: 'showError', message: 'No workspace folder open' });
      return;
    }

    const agentSession = this.sessionManager.createSession(prompt, this.currentModel, workspace);

    this.view?.webview.postMessage({ type: 'showThinking', message: 'Analyzing request...' });

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
          text: `Created branch: ${newBranch}`
        });
      } catch {
        // Continue without branch
      }
    }

    const config: ExecutorConfig = { maxIterations: 20, toolTimeout: 30000, temperature: 0.7 };
    await this.executeAgent(agentSession, config, token, chatSession);
  }

  private async executeAgent(
    agentSession: any,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    chatSession: ChatSession
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
          message: iteration === 1 ? 'Analyzing request...' : 'Continuing...'
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
                message: `Preparing to use ${partialTool}...`
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
          this.view?.webview.postMessage({ type: 'streamChunk', content: accumulatedExplanation });
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
          title: groupTitle
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
            detail: actionDetail
          });

          try {
            const result = await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            agentSession.toolCalls.push(result);

            if (['write_file', 'create_file', 'delete_file'].includes(toolCall.name)) {
              agentSession.filesChanged.push(toolCall.args?.path || toolCall.args?.file);
              this.refreshExplorer();
            }

            // Show success state
            const { actionText: successText, actionDetail: successDetail } = this.getToolSuccessInfo(toolCall.name, toolCall.args, result.output);
            this.view?.webview.postMessage({
              type: 'showToolAction',
              status: 'success',
              icon: actionIcon,
              text: successText,
              detail: successDetail
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
              detail: error.message
            });
            agentSession.errors.push(error.message);
            messages.push({ role: 'assistant', content: response });
            messages.push({ role: 'user', content: `Tool ${toolCall.name} failed: ${error.message}\n\nTry a different approach.` });
          }
        }

      } catch (error: any) {
        this.view?.webview.postMessage({ type: 'showError', message: error.message });
        break;
      }
    }

    // Finish the progress group
    this.view?.webview.postMessage({ type: 'finishProgressGroup' });
    this.view?.webview.postMessage({ type: 'hideThinking' });
    this.sessionManager.updateSession(agentSession.id, { status: 'completed' });

    const filesChanged = agentSession.filesChanged?.length || 0;
    let summary = filesChanged > 0 ? `**${filesChanged} file${filesChanged > 1 ? 's' : ''} modified**\n\n` : '';
    summary += accumulatedExplanation || 'Task completed successfully.';
    
    const summaryMsg: ChatMessage = { role: 'assistant', content: summary, timestamp: Date.now() };
    chatSession.messages.push(summaryMsg);
    
    this.view?.webview.postMessage({ type: 'finalMessage', content: summary });
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

  private async handleChatMode(session: ChatSession, prompt: string, token: vscode.CancellationToken) {
    let fullResponse = '';
    
    const chatMessages = session.messages
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
        this.view?.webview.postMessage({ type: 'streamChunk', content: fullResponse });
      }
    }

    const assistantMessage: ChatMessage = { role: 'assistant', content: fullResponse, timestamp: Date.now() };
    session.messages.push(assistantMessage);
    
    this.view?.webview.postMessage({ type: 'finalMessage', content: fullResponse });
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
