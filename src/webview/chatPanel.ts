import * as path from 'path';
import * as vscode from 'vscode';
import { getModeConfig } from '../config/settings';
import { AskModeHandler } from '../modes/askMode';
import { HistoryManager } from '../services/historyManager';
import { ModelManager } from '../services/modelManager';
import { OllamaClient } from '../services/ollamaClient';

interface ChatSession {
  id: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  title: string;
  model: string;
  timestamp: number;
}

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private sessions: Map<string, ChatSession> = new Map();
  private currentSessionId: string | null = null;
  private askHandler: AskModeHandler;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionPath: string,
    private readonly client: OllamaClient,
    _modelManager: ModelManager,
    _historyManager: HistoryManager
  ) {
    this.panel = panel;
    this.askHandler = new AskModeHandler(client, _historyManager);

    this.panel.webview.html = this.getWebviewContent();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'ready':
            await this.initialize();
            break;
          case 'sendMessage':
            await this.handleSendMessage(message.text, message.sessionId);
            break;
          case 'newChat':
            this.createNewSession();
            break;
          case 'selectModel':
            await this.handleModelSelection(message.model);
            break;
          case 'refreshSessions':
            this.sendSessionsList();
            break;
          case 'loadSession':
            this.loadSession(message.sessionId);
            break;
        }
      },
      null,
      this.disposables
    );
  }

  public static async createOrShow(
    extensionPath: string,
    client: OllamaClient,
    modelManager: ModelManager,
    historyManager: HistoryManager
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ollamaCopilotChat',
      'Ollama Copilot',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(extensionPath, 'src', 'webview'))
        ]
      }
    );

    ChatPanel.currentPanel = new ChatPanel(
      panel,
      extensionPath,
      client,
      modelManager,
      historyManager
    );
  }

  private async initialize(): Promise<void> {
    await this.loadModels();
    this.createNewSession();
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await this.client.listModels();
      const config = getModeConfig('ask');
      
      const modelList = models.map(m => ({
        name: m.name,
        selected: m.name === config.model
      }));

      this.panel.webview.postMessage({
        command: 'loadModels',
        models: modelList
      });
    } catch (error) {
      console.error('Failed to load models:', error);
    }
  }

  private createNewSession(): void {
    const config = getModeConfig('ask');
    const sessionId = `session-${Date.now()}`;
    
    const session: ChatSession = {
      id: sessionId,
      messages: [],
      title: 'New Chat',
      model: config.model || 'default',
      timestamp: Date.now()
    };

    this.sessions.set(sessionId, session);
    this.currentSessionId = sessionId;

    this.panel.webview.postMessage({
      command: 'newChat',
      sessionId: sessionId
    });

    this.sendSessionsList();
  }

  private loadSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.currentSessionId = sessionId;

    this.panel.webview.postMessage({
      command: 'newChat',
      sessionId: sessionId
    });

    // Reload messages
    for (const msg of session.messages) {
      this.panel.webview.postMessage({
        command: 'response',
        text: msg.content
      });
    }

    this.sendSessionsList();
  }

  private async handleSendMessage(text: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId || this.currentSessionId || '');
    if (!session) {
      this.panel.webview.postMessage({
        command: 'error',
        text: 'No active session'
      });
      return;
    }

    // Add user message
    session.messages.push({ role: 'user', content: text });

    // Update session title from first message
    if (session.messages.length === 1) {
      session.title = text.substring(0, 50) + (text.length > 50 ? '...' : '');
    }

    const config = getModeConfig('ask');
    if (!config.model) {
      this.panel.webview.postMessage({
        command: 'error',
        text: 'No model configured. Please select a model.'
      });
      return;
    }

    try {
      // Create a mock stream to capture the response
      let fullResponse = '';
      const mockStream = {
        markdown: (text: string) => {
          fullResponse += text;
          this.panel.webview.postMessage({
            command: 'streamChunk',
            text: fullResponse
          });
        },
        push: () => {},
        reference: () => {},
        button: () => {}
      };

      // Create mock request
      const mockRequest: any = {
        prompt: text,
        command: this.extractCommand(text),
        references: []
      };

      const mockContext: any = {
        history: []
      };

      const mockToken: vscode.CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: () => new vscode.Disposable(() => {})
      };

      // Call ask handler
      await this.askHandler.handleRequest(
        mockRequest,
        mockContext,
        mockStream as any,
        mockToken
      );

      // Save assistant response
      session.messages.push({ role: 'assistant', content: fullResponse });

      this.panel.webview.postMessage({
        command: 'response',
        text: fullResponse
      });

      this.sendSessionsList();

    } catch (error: any) {
      this.panel.webview.postMessage({
        command: 'error',
        text: error.message || 'An error occurred'
      });
    }
  }

  private extractCommand(text: string): string | undefined {
    const match = text.match(/^\/(\w+)/);
    return match ? match[1] : undefined;
  }

  private async handleModelSelection(modelName: string): Promise<void> {
    if (!modelName) return;

    await vscode.workspace.getConfiguration('ollamaCopilot')
      .update('askMode.model', modelName, vscode.ConfigurationTarget.Global);

    vscode.window.showInformationMessage(`Model set to: ${modelName}`);

    // Update current session model
    if (this.currentSessionId) {
      const session = this.sessions.get(this.currentSessionId);
      if (session) {
        session.model = modelName;
        this.sendSessionsList();
      }
    }
  }

  private sendSessionsList(): void {
    const sessions = Array.from(this.sessions.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(s => ({
        id: s.id,
        title: s.title,
        model: s.model,
        messageCount: s.messages.length,
        isActive: s.id === this.currentSessionId
      }));

    this.panel.webview.postMessage({
      command: 'loadSessions',
      sessions: sessions
    });
  }

  private getWebviewContent(): string {
    const htmlPath = path.join(this.extensionPath, 'src', 'webview', 'chatPanel.html');
    
    try {
      const fs = require('fs');
      return fs.readFileSync(htmlPath, 'utf8');
    } catch (error) {
      return `<!DOCTYPE html>
        <html>
          <head><title>Chat</title></head>
          <body>
            <h1>Ollama Copilot Chat</h1>
            <p>Could not load chat interface.</p>
          </body>
        </html>`;
    }
  }

  public dispose(): void {
    ChatPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
