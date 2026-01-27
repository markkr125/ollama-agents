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

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  mode: string;
  model: string;
  timestamp: number;
}

interface ContextItem {
  fileName: string;
  content: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollamaCopilot.chatView';
  private view?: vscode.WebviewView;
  private sessions: Map<string, ChatSession> = new Map();
  private currentSessionId: string = '';
  private currentMode: string = 'agent';
  private currentModel: string = '';
  private isGenerating = false;
  private cancellationTokenSource?: vscode.CancellationTokenSource;
  
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

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async data => {
      switch (data.type) {
        case 'ready':
          await this.initialize();
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
          await this.saveBearerToken(data.token);
          break;
      }
    });
  }

  private async initialize() {
    try {
      const models = await this.client.listModels();
      const modeConfig = getModeConfig('agent');
      this.currentModel = modeConfig.model || (models.length > 0 ? models[0].name : '');
      
      // Use centralized config
      const config = getConfig();
      const settings = {
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

      const hasToken = await this.tokenManager.hasToken();

      this.view?.webview.postMessage({
        type: 'init',
        models: models.map(m => ({ name: m.name, selected: m.name === this.currentModel })),
        currentMode: this.currentMode,
        settings,
        hasToken
      });

      this.sendSessionsList();
    } catch (error: any) {
      this.view?.webview.postMessage({
        type: 'connectionError',
        error: error.message
      });
    }
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
      await config.update('baseUrl', settings.baseUrl, vscode.ConfigurationTarget.Global);
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
    if (settings.completionModel !== undefined) {
      await config.update('completionMode.model', settings.completionModel, vscode.ConfigurationTarget.Global);
    }
    
    this.view?.webview.postMessage({ type: 'settingsSaved' });
  }

  private async testConnection() {
    try {
      const connected = await this.client.testConnection();
      this.view?.webview.postMessage({
        type: 'connectionTestResult',
        success: connected,
        message: connected ? 'Connected successfully!' : 'Connection failed'
      });
    } catch (error: any) {
      this.view?.webview.postMessage({
        type: 'connectionTestResult',
        success: false,
        message: error.message
      });
    }
  }

  private async saveBearerToken(token: string) {
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

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --border: var(--vscode-panel-border);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --hover: var(--vscode-list-hoverBackground);
      --accent: var(--vscode-focusBorder);
      --muted: var(--vscode-descriptionForeground);
      --success: var(--vscode-charts-green);
      --error: var(--vscode-errorForeground);
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Main Layout */
    .app {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .main-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Sessions Sidebar */
    .sessions-panel {
      width: 0;
      background: var(--input-bg);
      border-left: 1px solid var(--border);
      overflow: hidden;
      transition: width 0.2s;
      display: flex;
      flex-direction: column;
    }

    .sessions-panel.open {
      width: 220px;
    }

    .sessions-header {
      padding: 12px;
      font-weight: 600;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .sessions-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .session-item {
      padding: 8px 10px;
      border-radius: 4px;
      cursor: pointer;
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .session-item:hover { background: var(--hover); }
    .session-item.active { background: var(--btn-bg); color: var(--btn-fg); }

    .session-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    .session-time {
      font-size: 10px;
      color: var(--muted);
      margin-left: 8px;
    }

    .session-delete {
      opacity: 0;
      cursor: pointer;
      padding: 2px 6px;
      font-size: 10px;
    }

    .session-item:hover .session-delete { opacity: 0.6; }
    .session-delete:hover { opacity: 1 !important; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      min-height: 40px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .back-btn {
      display: none;
      background: transparent;
      border: none;
      color: var(--fg);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 14px;
    }

    .back-btn:hover { background: var(--hover); }
    .back-btn.visible { display: block; }

    .header-title {
      font-weight: 600;
      font-size: 13px;
    }

    .header-actions {
      display: flex;
      gap: 4px;
    }

    .icon-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      width: 28px;
      height: 28px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    .icon-btn:hover { background: var(--hover); }

    /* Pages */
    .page { display: none; flex-direction: column; flex: 1; overflow: hidden; }
    .page.active { display: flex; }

    /* Chat Page */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--muted);
    }

    .empty-state h3 {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
      color: var(--fg);
    }

    .message {
      margin-bottom: 16px;
    }

    .message-user {
      background: var(--input-bg);
      padding: 12px;
      border-radius: 8px;
    }

    .message-assistant {
      line-height: 1.6;
    }

    .message-assistant pre {
      background: var(--input-bg);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .message-assistant code {
      background: var(--input-bg);
      padding: 2px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .message-assistant pre code {
      background: none;
      padding: 0;
    }

    /* Tool Actions - Copilot Style */
    .progress-group {
      margin: 12px 0;
      border-radius: 6px;
      overflow: hidden;
    }

    .progress-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--input-bg);
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      font-weight: 500;
    }

    .progress-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .progress-chevron {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--muted);
    }

    .progress-group.collapsed .progress-chevron {
      transform: rotate(-90deg);
    }

    .progress-group.collapsed .progress-actions {
      display: none;
    }

    .progress-status {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .progress-status .spinner {
      width: 12px;
      height: 12px;
    }

    .progress-status.done {
      color: var(--success);
    }

    .progress-title {
      flex: 1;
    }

    .progress-actions {
      padding-left: 20px;
      border-left: 1px solid var(--border);
      margin-left: 18px;
    }

    .action-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 12px;
      color: var(--fg);
    }

    .action-item .action-status {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
    }

    .action-item .action-status.pending {
      color: var(--muted);
    }

    .action-item .action-status.running {
      color: var(--vscode-charts-yellow);
    }

    .action-item .action-status.done {
      color: var(--success);
    }

    .action-item .action-status.error {
      color: var(--error);
    }

    .action-item .file-icon {
      font-size: 14px;
    }

    .action-item .action-text {
      flex: 1;
      color: var(--muted);
    }

    .action-item .action-text .filename {
      color: var(--accent);
    }

    .action-item .action-text .detail {
      color: var(--muted);
      opacity: 0.8;
    }

    /* Thinking */
    .thinking {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      color: var(--muted);
      font-size: 12px;
    }

    .thinking.visible { display: flex; }

    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Input Area */
    .input-container {
      border-top: 1px solid var(--border);
      padding: 12px;
    }

    .context-chips {
      display: none;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }

    .context-chips.visible { display: flex; }

    .context-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
    }

    .context-chip-remove {
      cursor: pointer;
      opacity: 0.6;
    }

    .context-chip-remove:hover { opacity: 1; }

    .input-box {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }

    .input-box:focus-within { border-color: var(--accent); }

    textarea {
      width: 100%;
      padding: 12px;
      background: transparent;
      color: var(--input-fg);
      border: none;
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      min-height: 44px;
      max-height: 200px;
    }

    textarea::placeholder { color: var(--muted); }

    .input-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
    }

    .input-controls-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    select {
      padding: 4px 8px;
      background: transparent;
      color: var(--fg);
      border: none;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      outline: none;
    }

    select option {
      background: var(--input-bg);
      color: var(--fg);
    }

    .send-btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .send-btn:hover { opacity: 0.9; }
    .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Settings Layout */
    .settings-layout {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    .settings-nav {
      width: 140px;
      min-width: 140px;
      background: var(--bg);
      border-right: 1px solid var(--border);
      padding: 8px 0;
      overflow-y: auto;
    }

    .settings-nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      font-size: 12px;
      color: var(--muted);
      border-left: 3px solid transparent;
      transition: all 0.15s;
    }

    .settings-nav-item:hover {
      background: var(--input-bg);
      color: var(--fg);
    }

    .settings-nav-item.active {
      background: var(--input-bg);
      color: var(--accent);
      border-left-color: var(--accent);
    }

    .nav-icon {
      font-size: 14px;
    }

    /* Settings Content */
    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
    }

    .settings-section {
      display: none;
    }

    .settings-section.active {
      display: block;
    }

    .settings-section h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--fg);
    }

    .section-desc {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 20px;
    }

    .setting-group {
      margin-bottom: 24px;
    }

    .setting-group h3 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--fg);
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
    }

    .setting-row {
      display: flex;
      flex-direction: column;
      margin-bottom: 16px;
    }

    .setting-row label {
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--fg);
    }

    .setting-hint {
      font-size: 11px;
      color: var(--muted);
      margin-top: 4px;
    }

    .setting-row input,
    .setting-row select {
      padding: 8px 10px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      width: 100%;
    }

    .setting-row input:focus,
    .setting-row select:focus {
      border-color: var(--accent);
      outline: none;
    }

    .input-with-btn {
      display: flex;
      gap: 4px;
    }

    .input-with-btn input {
      flex: 1;
    }

    .btn-small {
      padding: 6px 8px;
      font-size: 12px;
    }

    .token-status {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 0;
      font-size: 11px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }

    .token-status.configured .status-dot {
      background: var(--success);
    }

    .setting-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .slider-row input[type="range"] {
      flex: 1;
      -webkit-appearance: none;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
    }

    .slider-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      background: var(--accent);
      border-radius: 50%;
      cursor: pointer;
    }

    /* Toggle Row */
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }

    .toggle-row:last-child {
      border-bottom: none;
    }

    .toggle-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .toggle-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
    }

    .toggle-desc {
      font-size: 11px;
      color: var(--muted);
    }

    .toggle {
      width: 36px;
      height: 20px;
      background: var(--border);
      border-radius: 10px;
      cursor: pointer;
      position: relative;
      transition: background 0.2s;
      flex-shrink: 0;
    }

    .toggle.on { background: var(--btn-bg); }

    .toggle::after {
      content: '';
      position: absolute;
      width: 16px;
      height: 16px;
      background: white;
      border-radius: 50%;
      top: 2px;
      left: 2px;
      transition: left 0.2s;
    }

    .toggle.on::after { left: 18px; }

    /* Tools Grid */
    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }

    .tool-card {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
    }

    .tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }

    .tool-icon {
      font-size: 16px;
    }

    .tool-name {
      font-size: 12px;
      font-weight: 500;
      flex: 1;
      color: var(--fg);
      font-family: monospace;
    }

    .tool-desc {
      font-size: 11px;
      color: var(--muted);
      margin: 0;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      border: none;
    }

    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }

    .btn-secondary {
      background: var(--input-bg);
      color: var(--fg);
      border: 1px solid var(--border);
    }

    .status-msg {
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      margin-top: 8px;
      display: none;
    }

    .status-msg.visible { display: block; }
    .status-msg.success { background: rgba(0, 200, 0, 0.1); color: var(--success); }
    .status-msg.error { background: rgba(200, 0, 0, 0.1); color: var(--error); }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
  </style>
</head>
<body>
  <div class="app">
    <div class="main-panel">
      <div class="header">
        <div class="header-left">
          <button class="back-btn" id="backBtn">←</button>
          <span class="header-title" id="headerTitle">Copilot</span>
        </div>
        <div class="header-actions">
          <button class="icon-btn" id="newChatBtn" title="New Chat">➕</button>
          <button class="icon-btn" id="settingsBtn" title="Settings">⚙️</button>
          <button class="icon-btn" id="sessionsBtn" title="Sessions">📋</button>
        </div>
      </div>

      <!-- Chat Page -->
      <div class="page active" id="chatPage">
        <div class="messages" id="messages">
          <div class="empty-state" id="emptyState">
            <h3>How can I help you today?</h3>
            <p>Ask me to write code, explain concepts, or help with your project.</p>
          </div>
        </div>

        <div class="thinking" id="thinking">
          <div class="spinner"></div>
          <span id="thinkingText">Thinking...</span>
        </div>

        <div class="input-container">
          <div class="context-chips" id="contextChips"></div>
          <div class="input-box">
            <textarea id="input" placeholder="Describe what to build next" rows="1"></textarea>
            <div class="input-controls">
              <div class="input-controls-left">
                <button class="icon-btn" id="addContextBtn" title="Add context">📎</button>
                <select id="modeSelect">
                  <option value="agent">Agent</option>
                  <option value="ask">Ask</option>
                  <option value="edit">Edit</option>
                </select>
                <select id="modelSelect">
                  <option value="">Loading...</option>
                </select>
              </div>
              <button class="send-btn" id="sendBtn">Send</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Settings Page -->
      <div class="page" id="settingsPage">
        <div class="settings-layout">
          <div class="settings-nav">
            <div class="settings-nav-item active" data-section="connection">
              <span class="nav-icon">🔌</span>
              <span>Connection</span>
            </div>
            <div class="settings-nav-item" data-section="models">
              <span class="nav-icon">🤖</span>
              <span>Models</span>
            </div>
            <div class="settings-nav-item" data-section="chat">
              <span class="nav-icon">💬</span>
              <span>Chat</span>
            </div>
            <div class="settings-nav-item" data-section="autocomplete">
              <span class="nav-icon">✨</span>
              <span>Autocomplete</span>
            </div>
            <div class="settings-nav-item" data-section="tools">
              <span class="nav-icon">🔧</span>
              <span>Tools</span>
            </div>
            <div class="settings-nav-item" data-section="agent">
              <span class="nav-icon">⚡</span>
              <span>Agent</span>
            </div>
          </div>

          <div class="settings-content">
            <!-- Connection Section -->
            <div class="settings-section active" id="section-connection">
              <h2>Connection Settings</h2>
              <p class="section-desc">Configure your Ollama or OpenWebUI server connection.</p>
              
              <div class="setting-group">
                <div class="setting-row">
                  <label>Server URL</label>
                  <input type="text" id="baseUrlInput" placeholder="http://localhost:11434">
                  <span class="setting-hint">The URL of your Ollama server or OpenWebUI instance</span>
                </div>
              </div>

              <div class="setting-group">
                <h3>Authentication</h3>
                <div class="setting-row">
                  <label>Bearer Token</label>
                  <div class="input-with-btn">
                    <input type="password" id="bearerTokenInput" placeholder="Enter token for OpenWebUI...">
                    <button class="btn btn-small" id="showTokenBtn">👁</button>
                  </div>
                  <span class="setting-hint">Required for OpenWebUI authentication</span>
                </div>
                <div class="token-status" id="tokenStatus">
                  <span class="status-dot"></span>
                  <span id="tokenStatusText">No token configured</span>
                </div>
              </div>

              <div class="setting-actions">
                <button class="btn btn-secondary" id="testConnectionBtn">Test Connection</button>
                <button class="btn btn-primary" id="saveTokenBtn">Save Token</button>
              </div>
              <div class="status-msg" id="connectionStatus"></div>
            </div>

            <!-- Models Section -->
            <div class="settings-section" id="section-models">
              <h2>Model Configuration</h2>
              <p class="section-desc">Choose which models to use for each mode.</p>
              
              <div class="setting-group">
                <div class="setting-row">
                  <label>Agent Mode Model</label>
                  <select id="agentModelSelect"></select>
                  <span class="setting-hint">Model used for autonomous agent tasks</span>
                </div>
                
                <div class="setting-row">
                  <label>Ask Mode Model</label>
                  <select id="askModelSelect"></select>
                  <span class="setting-hint">Model used for chat conversations</span>
                </div>
                
                <div class="setting-row">
                  <label>Edit Mode Model</label>
                  <select id="editModelSelect"></select>
                  <span class="setting-hint">Model used for code editing</span>
                </div>
                
                <div class="setting-row">
                  <label>Completion Model</label>
                  <select id="completionModelSelect"></select>
                  <span class="setting-hint">Model used for inline code completions</span>
                </div>
              </div>

              <button class="btn btn-primary" id="saveModelsBtn">Save Model Settings</button>
              <div class="status-msg" id="modelsStatus"></div>
            </div>

            <!-- Chat Section -->
            <div class="settings-section" id="section-chat">
              <h2>Chat Settings</h2>
              <p class="section-desc">Configure chat behavior and preferences.</p>
              
              <div class="setting-group">
                <div class="toggle-row">
                  <div class="toggle-info">
                    <span class="toggle-label">Stream Responses</span>
                    <span class="toggle-desc">Show responses as they are generated</span>
                  </div>
                  <div class="toggle on" id="streamToggle"></div>
                </div>

                <div class="toggle-row">
                  <div class="toggle-info">
                    <span class="toggle-label">Show Tool Actions</span>
                    <span class="toggle-desc">Display tool execution details in chat</span>
                  </div>
                  <div class="toggle on" id="showToolsToggle"></div>
                </div>
              </div>

              <div class="setting-group">
                <div class="setting-row">
                  <label>Temperature</label>
                  <div class="slider-row">
                    <input type="range" id="temperatureSlider" min="0" max="100" value="70">
                    <span id="temperatureValue">0.7</span>
                  </div>
                  <span class="setting-hint">Higher = more creative, Lower = more focused</span>
                </div>
              </div>
            </div>

            <!-- Autocomplete Section -->
            <div class="settings-section" id="section-autocomplete">
              <h2>Autocomplete Settings</h2>
              <p class="section-desc">Configure inline code completion behavior.</p>
              
              <div class="setting-group">
                <div class="toggle-row">
                  <div class="toggle-info">
                    <span class="toggle-label">Enable Autocomplete</span>
                    <span class="toggle-desc">Show inline code suggestions as you type</span>
                  </div>
                  <div class="toggle" id="autocompleteToggle"></div>
                </div>

                <div class="toggle-row">
                  <div class="toggle-info">
                    <span class="toggle-label">Auto-trigger</span>
                    <span class="toggle-desc">Automatically trigger completions while typing</span>
                  </div>
                  <div class="toggle on" id="autoTriggerToggle"></div>
                </div>
              </div>

              <div class="setting-group">
                <div class="setting-row">
                  <label>Trigger Delay (ms)</label>
                  <input type="number" id="triggerDelayInput" value="300" min="100" max="2000">
                  <span class="setting-hint">Delay before showing completions</span>
                </div>

                <div class="setting-row">
                  <label>Max Tokens</label>
                  <input type="number" id="maxTokensInput" value="500" min="50" max="2000">
                  <span class="setting-hint">Maximum tokens per completion</span>
                </div>
              </div>
            </div>

            <!-- Tools Section -->
            <div class="settings-section" id="section-tools">
              <h2>Agent Tools</h2>
              <p class="section-desc">Enable or disable tools available to the agent.</p>
              
              <div class="tools-grid">
                <div class="tool-card">
                  <div class="tool-header">
                    <span class="tool-icon">📄</span>
                    <span class="tool-name">read_file</span>
                    <div class="toggle on" data-tool="read_file"></div>
                  </div>
                  <p class="tool-desc">Read contents of files in the workspace</p>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <span class="tool-icon">✏️</span>
                    <span class="tool-name">write_file</span>
                    <div class="toggle on" data-tool="write_file"></div>
                  </div>
                  <p class="tool-desc">Write content to files in the workspace</p>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <span class="tool-icon">📁</span>
                    <span class="tool-name">create_file</span>
                    <div class="toggle on" data-tool="create_file"></div>
                  </div>
                  <p class="tool-desc">Create new files in the workspace</p>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <span class="tool-icon">📋</span>
                    <span class="tool-name">list_files</span>
                    <div class="toggle on" data-tool="list_files"></div>
                  </div>
                  <p class="tool-desc">List files and directories</p>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <span class="tool-icon">🔍</span>
                    <span class="tool-name">search_workspace</span>
                    <div class="toggle on" data-tool="search_workspace"></div>
                  </div>
                  <p class="tool-desc">Search for text across the workspace</p>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <span class="tool-icon">⚡</span>
                    <span class="tool-name">run_command</span>
                    <div class="toggle on" data-tool="run_command"></div>
                  </div>
                  <p class="tool-desc">Execute terminal commands</p>
                </div>
              </div>
            </div>

            <!-- Agent Section -->
            <div class="settings-section" id="section-agent">
              <h2>Agent Settings</h2>
              <p class="section-desc">Configure autonomous agent behavior.</p>
              
              <div class="setting-group">
                <div class="setting-row">
                  <label>Max Iterations</label>
                  <input type="number" id="maxIterationsInput" value="25" min="5" max="100">
                  <span class="setting-hint">Maximum tool execution cycles per task</span>
                </div>

                <div class="setting-row">
                  <label>Tool Timeout (seconds)</label>
                  <input type="number" id="toolTimeoutInput" value="30" min="5" max="300">
                  <span class="setting-hint">Maximum time to wait for each tool</span>
                </div>
              </div>

              <div class="setting-group">
                <div class="toggle-row">
                  <div class="toggle-info">
                    <span class="toggle-label">Auto-create Git Branch</span>
                    <span class="toggle-desc">Create a new branch for each agent task</span>
                  </div>
                  <div class="toggle on" id="gitBranchToggle"></div>
                </div>

                <div class="toggle-row">
                  <div class="toggle-info">
                    <span class="toggle-label">Auto-commit Changes</span>
                    <span class="toggle-desc">Automatically commit changes when task completes</span>
                  </div>
                  <div class="toggle" id="autoCommitToggle"></div>
                </div>
              </div>

              <button class="btn btn-primary" id="saveAgentBtn">Save Agent Settings</button>
              <div class="status-msg" id="agentStatus"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sessions Sidebar -->
    <div class="sessions-panel" id="sessionsPanel">
      <div class="sessions-header">
        <span>Sessions</span>
        <button class="icon-btn" id="closeSessionsBtn">✕</button>
      </div>
      <div class="sessions-list" id="sessionsList"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const $ = sel => document.querySelector(sel);
    const $$ = sel => document.querySelectorAll(sel);

    const el = {
      messages: $('#messages'),
      emptyState: $('#emptyState'),
      input: $('#input'),
      sendBtn: $('#sendBtn'),
      modelSelect: $('#modelSelect'),
      modeSelect: $('#modeSelect'),
      contextChips: $('#contextChips'),
      addContextBtn: $('#addContextBtn'),
      newChatBtn: $('#newChatBtn'),
      settingsBtn: $('#settingsBtn'),
      sessionsBtn: $('#sessionsBtn'),
      thinking: $('#thinking'),
      thinkingText: $('#thinkingText'),
      chatPage: $('#chatPage'),
      settingsPage: $('#settingsPage'),
      sessionsPanel: $('#sessionsPanel'),
      sessionsList: $('#sessionsList'),
      backBtn: $('#backBtn'),
      headerTitle: $('#headerTitle'),
      closeSessionsBtn: $('#closeSessionsBtn'),
      // Connection settings
      baseUrlInput: $('#baseUrlInput'),
      bearerTokenInput: $('#bearerTokenInput'),
      showTokenBtn: $('#showTokenBtn'),
      tokenStatus: $('#tokenStatus'),
      tokenStatusText: $('#tokenStatusText'),
      testConnectionBtn: $('#testConnectionBtn'),
      saveTokenBtn: $('#saveTokenBtn'),
      connectionStatus: $('#connectionStatus'),
      // Models settings
      agentModelSelect: $('#agentModelSelect'),
      askModelSelect: $('#askModelSelect'),
      editModelSelect: $('#editModelSelect'),
      completionModelSelect: $('#completionModelSelect'),
      saveModelsBtn: $('#saveModelsBtn'),
      modelsStatus: $('#modelsStatus'),
      // Chat settings
      streamToggle: $('#streamToggle'),
      showToolsToggle: $('#showToolsToggle'),
      temperatureSlider: $('#temperatureSlider'),
      temperatureValue: $('#temperatureValue'),
      // Autocomplete settings
      autocompleteToggle: $('#autocompleteToggle'),
      autoTriggerToggle: $('#autoTriggerToggle'),
      triggerDelayInput: $('#triggerDelayInput'),
      maxTokensInput: $('#maxTokensInput'),
      // Agent settings
      maxIterationsInput: $('#maxIterationsInput'),
      toolTimeoutInput: $('#toolTimeoutInput'),
      gitBranchToggle: $('#gitBranchToggle'),
      autoCommitToggle: $('#autoCommitToggle'),
      saveAgentBtn: $('#saveAgentBtn'),
      agentStatus: $('#agentStatus')
    };

    let isGenerating = false;
    let contextList = [];
    let currentStreamDiv = null;
    let currentPage = 'chat';

    // Settings Navigation
    $$('.settings-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const section = item.dataset.section;
        $$('.settings-nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        $$('.settings-section').forEach(s => s.classList.remove('active'));
        $(\`#section-\${section}\`).classList.add('active');
      });
    });

    // Toggle Buttons
    $$('.toggle').forEach(toggle => {
      toggle.addEventListener('click', function() {
        this.classList.toggle('on');
      });
    });

    // Temperature Slider
    el.temperatureSlider?.addEventListener('input', function() {
      el.temperatureValue.textContent = (this.value / 100).toFixed(1);
    });

    // Show/Hide Token
    el.showTokenBtn?.addEventListener('click', () => {
      const input = el.bearerTokenInput;
      input.type = input.type === 'password' ? 'text' : 'password';
      el.showTokenBtn.textContent = input.type === 'password' ? '👁' : '🙈';
    });

    // Page Navigation
    function showPage(page) {
      currentPage = page;
      el.chatPage.classList.toggle('active', page === 'chat');
      el.settingsPage.classList.toggle('active', page === 'settings');
      el.backBtn.classList.toggle('visible', page !== 'chat');
      el.headerTitle.textContent = page === 'settings' ? 'Settings' : 'Copilot';
    }

    el.settingsBtn.addEventListener('click', () => showPage('settings'));
    el.backBtn.addEventListener('click', () => showPage('chat'));

    // Sessions Panel
    el.sessionsBtn.addEventListener('click', () => {
      el.sessionsPanel.classList.toggle('open');
    });

    el.closeSessionsBtn.addEventListener('click', () => {
      el.sessionsPanel.classList.remove('open');
    });

    // Auto-resize textarea
    el.input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    });

    // Send
    function send() {
      const text = el.input.value.trim();
      if (!text || isGenerating) return;
      vscode.postMessage({ type: 'sendMessage', text, context: contextList });
      el.input.value = '';
      el.input.style.height = 'auto';
      contextList = [];
      updateContextUI();
    }

    el.sendBtn.addEventListener('click', () => {
      if (isGenerating) {
        vscode.postMessage({ type: 'stopGeneration' });
      } else {
        send();
      }
    });

    el.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isGenerating) send();
      }
    });

    el.modeSelect.addEventListener('change', e => {
      vscode.postMessage({ type: 'selectMode', mode: e.target.value });
    });

    el.modelSelect.addEventListener('change', e => {
      vscode.postMessage({ type: 'selectModel', model: e.target.value });
    });

    el.newChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
    el.addContextBtn.addEventListener('click', () => vscode.postMessage({ type: 'addContext' }));

    // Settings
    el.testConnectionBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'testConnection' });
    });

    el.saveTokenBtn?.addEventListener('click', () => {
      const token = el.bearerTokenInput.value;
      if (token) {
        vscode.postMessage({ type: 'saveBearerToken', token });
        el.tokenStatus.classList.add('configured');
        el.tokenStatusText.textContent = 'Token configured';
      }
    });

    el.saveModelsBtn?.addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveSettings',
        settings: {
          agentModel: el.agentModelSelect.value,
          askModel: el.askModelSelect.value,
          editModel: el.editModelSelect?.value,
          completionModel: el.completionModelSelect.value
        }
      });
      showStatus(el.modelsStatus, 'Model settings saved!', true);
    });

    el.saveAgentBtn?.addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveSettings',
        settings: {
          maxIterations: parseInt(el.maxIterationsInput.value),
          toolTimeout: parseInt(el.toolTimeoutInput.value),
          autoCreateBranch: el.gitBranchToggle.classList.contains('on'),
          autoCommit: el.autoCommitToggle.classList.contains('on')
        }
      });
      showStatus(el.agentStatus, 'Agent settings saved!', true);
    });

    el.autocompleteToggle.addEventListener('click', function() {
      vscode.postMessage({
        type: 'saveSettings',
        settings: { enableAutoComplete: this.classList.contains('on') }
      });
    });

    function updateContextUI() {
      el.contextChips.innerHTML = '';
      if (contextList.length === 0) {
        el.contextChips.classList.remove('visible');
        return;
      }
      el.contextChips.classList.add('visible');
      contextList.forEach((c, i) => {
        const chip = document.createElement('div');
        chip.className = 'context-chip';
        chip.innerHTML = \`<span>📄 \${c.fileName}</span><span class="context-chip-remove" data-i="\${i}">×</span>\`;
        el.contextChips.appendChild(chip);
      });
      $$('.context-chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          contextList.splice(parseInt(btn.dataset.i), 1);
          updateContextUI();
        });
      });
    }

    function hideEmpty() {
      if (el.emptyState) el.emptyState.style.display = 'none';
    }

    function showThinking(msg) {
      el.thinkingText.textContent = msg || 'Thinking...';
      el.thinking.classList.add('visible');
    }

    function hideThinking() {
      el.thinking.classList.remove('visible');
    }

    function showStatus(element, msg, isSuccess) {
      element.textContent = msg;
      element.className = 'status-msg visible ' + (isSuccess ? 'success' : 'error');
      setTimeout(() => element.classList.remove('visible'), 3000);
    }

    function addUserMessage(content) {
      hideEmpty();
      const div = document.createElement('div');
      div.className = 'message message-user';
      div.textContent = content;
      el.messages.appendChild(div);
      el.messages.scrollTop = el.messages.scrollHeight;
    }

    let currentProgressGroup = null;
    let currentProgressActions = null;

    function startProgressGroup(title) {
      hideEmpty();
      hideThinking();
      
      const group = document.createElement('div');
      group.className = 'progress-group';
      group.innerHTML = \`
        <div class="progress-header">
          <span class="progress-chevron">▼</span>
          <span class="progress-status"><div class="spinner"></div></span>
          <span class="progress-title">\${title}</span>
        </div>
        <div class="progress-actions"></div>
      \`;
      
      group.querySelector('.progress-header').addEventListener('click', () => {
        group.classList.toggle('collapsed');
      });
      
      el.messages.appendChild(group);
      currentProgressGroup = group;
      currentProgressActions = group.querySelector('.progress-actions');
      el.messages.scrollTop = el.messages.scrollHeight;
    }

    function addActionToGroup(status, icon, text, detail) {
      if (!currentProgressActions) {
        startProgressGroup('Working on task');
      }
      
      const statusClass = status === 'running' ? 'running' : status === 'success' ? 'done' : status === 'error' ? 'error' : 'pending';
      const statusIcon = status === 'running' ? '<div class="spinner"></div>' : 
                         status === 'success' ? '✓' : 
                         status === 'error' ? '✗' : '○';
      
      const item = document.createElement('div');
      item.className = 'action-item';
      item.dataset.actionId = Date.now().toString();
      item.innerHTML = \`
        <span class="action-status \${statusClass}">\${statusIcon}</span>
        <span class="file-icon">\${icon}</span>
        <span class="action-text"><span class="filename">\${text}</span>\${detail ? '<span class="detail">, ' + detail + '</span>' : ''}</span>
      \`;
      
      currentProgressActions.appendChild(item);
      el.messages.scrollTop = el.messages.scrollHeight;
      return item.dataset.actionId;
    }

    function updateActionStatus(actionId, status) {
      const item = currentProgressActions?.querySelector(\`[data-action-id="\${actionId}"]\`);
      if (!item) return;
      
      const statusEl = item.querySelector('.action-status');
      statusEl.className = 'action-status ' + (status === 'success' ? 'done' : status);
      statusEl.innerHTML = status === 'running' ? '<div class="spinner"></div>' : 
                           status === 'success' ? '✓' : 
                           status === 'error' ? '✗' : '○';
    }

    function finishProgressGroup() {
      if (currentProgressGroup) {
        const statusEl = currentProgressGroup.querySelector('.progress-status');
        statusEl.classList.add('done');
        statusEl.innerHTML = '✓';
      }
      currentProgressGroup = null;
      currentProgressActions = null;
    }

    // Legacy function for compatibility
    function addToolAction(status, icon, text) {
      hideThinking();
      addActionToGroup(status, icon, text, null);
    }

    function startAssistantMessage() {
      hideEmpty();
      hideThinking();
      const div = document.createElement('div');
      div.className = 'message message-assistant';
      el.messages.appendChild(div);
      currentStreamDiv = div;
      el.messages.scrollTop = el.messages.scrollHeight;
    }

    function updateStream(content) {
      if (!currentStreamDiv) startAssistantMessage();
      currentStreamDiv.innerHTML = formatMarkdown(content);
      el.messages.scrollTop = el.messages.scrollHeight;
    }

    function finalizeMessage(content) {
      hideThinking();
      if (!currentStreamDiv) startAssistantMessage();
      currentStreamDiv.innerHTML = formatMarkdown(content);
      currentStreamDiv = null;
    }

    function formatMarkdown(text) {
      if (!text) return '';
      text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
      text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      text = text.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      text = text.replace(/\\n/g, '<br>');
      return text;
    }

    function populateModelSelects(models) {
      [el.modelSelect, el.agentModelSelect, el.askModelSelect, el.editModelSelect, el.completionModelSelect].forEach(select => {
        if (!select) return;
        select.innerHTML = '';
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = m.name;
          if (m.selected) opt.selected = true;
          select.appendChild(opt);
        });
      });
    }

    function renderSessions(sessions) {
      el.sessionsList.innerHTML = '';
      sessions.forEach(s => {
        const div = document.createElement('div');
        div.className = 'session-item' + (s.active ? ' active' : '');
        const time = new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = \`
          <span class="session-title">\${s.title}</span>
          <span class="session-time">\${time}</span>
          <span class="session-delete" data-id="\${s.id}">✕</span>
        \`;
        div.addEventListener('click', e => {
          if (!e.target.classList.contains('session-delete')) {
            vscode.postMessage({ type: 'loadSession', sessionId: s.id });
          }
        });
        el.sessionsList.appendChild(div);
      });

      $$('.session-delete').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteSession', sessionId: btn.dataset.id });
        });
      });
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      switch (msg.type) {
        case 'init':
          populateModelSelects(msg.models);
          if (msg.currentMode) el.modeSelect.value = msg.currentMode;
          if (msg.settings) {
            // Connection settings
            if (el.baseUrlInput) el.baseUrlInput.value = msg.settings.baseUrl || 'http://localhost:11434';
            
            // Model selections - set after a short delay to ensure options are populated
            setTimeout(() => {
              if (el.agentModelSelect && msg.settings.agentModel) {
                el.agentModelSelect.value = msg.settings.agentModel;
              }
              if (el.askModelSelect && msg.settings.askModel) {
                el.askModelSelect.value = msg.settings.askModel;
              }
              if (el.editModelSelect && msg.settings.editModel) {
                el.editModelSelect.value = msg.settings.editModel;
              }
              if (el.completionModelSelect && msg.settings.completionModel) {
                el.completionModelSelect.value = msg.settings.completionModel;
              }
            }, 50);
            
            // Feature toggles
            if (el.autocompleteToggle) {
              el.autocompleteToggle.classList.toggle('on', msg.settings.enableAutoComplete);
            }
            
            // Agent settings
            if (el.maxIterationsInput && msg.settings.maxIterations) {
              el.maxIterationsInput.value = msg.settings.maxIterations;
            }
            if (el.toolTimeoutInput && msg.settings.toolTimeout) {
              el.toolTimeoutInput.value = Math.floor(msg.settings.toolTimeout / 1000);
            }
            
            // Temperature slider
            if (el.temperatureSlider && msg.settings.temperature !== undefined) {
              el.temperatureSlider.value = Math.round(msg.settings.temperature * 100);
              if (el.temperatureValue) el.temperatureValue.textContent = msg.settings.temperature.toFixed(1);
            }
          }
          
          // Token status
          if (msg.hasToken && el.tokenStatus) {
            el.tokenStatus.classList.add('configured');
            el.tokenStatusText.textContent = 'Token configured';
          }
          break;

        case 'loadSessions':
          renderSessions(msg.sessions);
          break;

        case 'loadSessionMessages':
          el.messages.innerHTML = '';
          msg.messages.forEach(m => {
            if (m.role === 'user') addUserMessage(m.content);
            else if (m.role === 'assistant') {
              startAssistantMessage();
              finalizeMessage(m.content);
            }
          });
          if (msg.messages.length === 0) {
            el.messages.appendChild(el.emptyState);
            el.emptyState.style.display = 'flex';
          }
          break;

        case 'addMessage':
          if (msg.message.role === 'user') addUserMessage(msg.message.content);
          break;

        case 'showThinking':
          showThinking(msg.message);
          break;

        case 'hideThinking':
          hideThinking();
          break;

        case 'startProgressGroup':
          startProgressGroup(msg.title);
          break;

        case 'showToolAction':
          addActionToGroup(msg.status, msg.icon, msg.text, msg.detail);
          break;

        case 'finishProgressGroup':
          finishProgressGroup();
          break;

        case 'streamChunk':
          updateStream(msg.content);
          break;

        case 'finalMessage':
          finishProgressGroup();
          finalizeMessage(msg.content);
          break;

        case 'generationStarted':
          isGenerating = true;
          el.sendBtn.textContent = 'Stop';
          break;

        case 'generationStopped':
          isGenerating = false;
          el.sendBtn.textContent = 'Send';
          hideThinking();
          break;

        case 'addContextItem':
          contextList.push(msg.context);
          updateContextUI();
          break;

        case 'showError':
          hideThinking();
          addActionToGroup('error', '✗', msg.message, null);
          break;

        case 'clearMessages':
          el.messages.innerHTML = '';
          el.messages.appendChild(el.emptyState);
          el.emptyState.style.display = 'flex';
          currentStreamDiv = null;
          currentProgressGroup = null;
          currentProgressActions = null;
          break;

        case 'connectionTestResult':
          showStatus(el.connectionStatus, msg.message, msg.success);
          break;

        case 'settingsSaved':
          // Settings are auto-saved per section
          break;

        case 'bearerTokenSaved':
          el.bearerTokenInput.value = '';
          break;

        case 'connectionError':
          showStatus(el.connectionStatus, 'Connection error: ' + msg.error, false);
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
