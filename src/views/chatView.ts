/**
 * THIN orchestrator — webview lifecycle + message routing only.
 * All business logic lives in IMessageHandler implementations under ./messageHandlers/.
 */
import { readFile } from 'fs/promises';
import * as vscode from 'vscode';
import { AgentChatExecutor } from '../agent/execution/orchestration/agentChatExecutor';
import { AgentExploreExecutor } from '../agent/execution/orchestration/agentExploreExecutor';
import { GitOperations } from '../agent/git/gitOperations';
import { SessionManager } from '../agent/sessions/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { DatabaseService } from '../services/database/databaseService';
import { ModelManager } from '../services/model/modelManager';
import { OllamaClient } from '../services/model/ollamaClient';
import { PendingEditDecorationProvider } from '../services/review/pendingEditDecorationProvider';
import { PendingEditReviewService } from '../services/review/pendingEditReviewService';
import { TerminalManager } from '../services/terminalManager';
import { TokenManager } from '../services/tokenManager';
import { ChatSessionController } from './chatSessionController';
import { ViewState, WebviewMessageEmitter } from './chatTypes';
import { EditorContextTracker } from './editorContextTracker';
import { ApprovalMessageHandler } from './messageHandlers/approvalMessageHandler';
import { ChatMessageHandler } from './messageHandlers/chatMessageHandler';
import { FileChangeMessageHandler } from './messageHandlers/fileChangeMessageHandler';
import { ModelMessageHandler } from './messageHandlers/modelMessageHandler';
import { ReviewNavMessageHandler } from './messageHandlers/reviewNavMessageHandler';
import { SessionMessageHandler } from './messageHandlers/sessionMessageHandler';
import { SettingsMessageHandler } from './messageHandlers/settingsMessageHandler';
import { MessageRouter } from './messageRouter';
import { SettingsHandler } from './settingsHandler';

export class ChatViewProvider implements vscode.WebviewViewProvider, WebviewMessageEmitter {
  public static readonly viewType = 'ollamaCopilot.chatView';
  private view?: vscode.WebviewView;
  private configChangeDisposable?: vscode.Disposable;

  private readonly state: ViewState;
  private readonly sessionController: ChatSessionController;
  private readonly settingsHandler: SettingsHandler;
  private readonly agentExecutor: AgentChatExecutor;
  private readonly exploreExecutor: AgentExploreExecutor;
  private readonly terminalManager: TerminalManager;
  private readonly messageRouter: MessageRouter;
  private editorContextTracker?: EditorContextTracker;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: OllamaClient,
    _modelManager: ModelManager,
    tokenManager: TokenManager,
    sessionManager: SessionManager,
    databaseService: DatabaseService,
    decorationProvider: PendingEditDecorationProvider,
    reviewService?: PendingEditReviewService
  ) {
    this.state = {
      currentMode: 'agent',
      currentModel: '',
      activeSessions: new Map()
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerBuiltInTools();
    const outputChannel = vscode.window.createOutputChannel('Ollama Copilot Agent');
    const gitOps = new GitOperations();
    this.terminalManager = new TerminalManager();

    this.sessionController = new ChatSessionController(
      databaseService,
      this,
      (sessionId: string) => this.state.activeSessions.has(sessionId)
    );
    this.settingsHandler = new SettingsHandler(client, tokenManager, databaseService, this);
    this.agentExecutor = new AgentChatExecutor(
      client,
      toolRegistry,
      databaseService,
      sessionManager,
      outputChannel,
      this,
      () => this.refreshExplorer(),
      this.terminalManager,
      decorationProvider
    );
    this.exploreExecutor = new AgentExploreExecutor(
      client,
      toolRegistry,
      databaseService,
      outputChannel,
      this
    );

    // Build message handlers
    const modelHandler = new ModelMessageHandler(this, client, databaseService);
    const chatHandler = new ChatMessageHandler(
      this.state, this, this.sessionController, this.settingsHandler,
      this.agentExecutor, this.exploreExecutor, databaseService, client, tokenManager,
      sessionManager, gitOps, modelHandler, reviewService
    );
    const sessionHandler = new SessionMessageHandler(this.state, this, this.sessionController);
    const settingsMessageHandler = new SettingsMessageHandler(this.settingsHandler);
    const approvalHandler = new ApprovalMessageHandler(this, this.sessionController, this.agentExecutor, databaseService);
    const fileChangeHandler = new FileChangeMessageHandler(this, this.sessionController, this.agentExecutor, reviewService);
    const reviewNavHandler = new ReviewNavMessageHandler(this, reviewService);

    this.messageRouter = new MessageRouter([
      chatHandler,
      sessionHandler,
      settingsMessageHandler,
      approvalHandler,
      fileChangeHandler,
      modelHandler,
      reviewNavHandler
    ]);

    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('ollamaCopilot')) {
        await this.settingsHandler.sendSettingsUpdate();
      }
    });

    // Subscribe to review service file-resolved events → update DB + files-changed widget
    if (reviewService) {
      reviewService.onDidResolveFile(async (event) => {
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
      reviewService.onDidUpdateHunkStats((event) => {
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
      this.editorContextTracker?.dispose();
      this.editorContextTracker = undefined;
      this.terminalManager.dispose();
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.settingsHandler.sendSettingsUpdate();
        this.sessionController.sendSessionsList();
        this.editorContextTracker?.sendNow();
      }
    });

    // Start tracking active editor / selection for implicit context chips
    this.editorContextTracker = new EditorContextTracker(this);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };

    webviewView.webview.html = await this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(data => {
      this.messageRouter.route(data).catch(err => {
        console.error('[ChatView] Unhandled error in message handler:', err);
      });
      // On initial ready, send editor context so the implicit file chip appears immediately
      if (data.type === 'ready') {
        this.editorContextTracker?.sendNow();
      }
    });
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
