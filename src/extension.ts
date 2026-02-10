import * as vscode from 'vscode';
import { SessionManager } from './agent/sessionManager';
import { TaskTracker } from './agent/taskTracker';
import { getConfig, getModeConfig } from './config/settings';
import { registerAgentMode } from './modes/agentMode';
import { registerEditMode } from './modes/editMode';
import { registerPlanMode } from './modes/planMode';
import { CompletionProvider } from './providers/completionProvider';
import { disposeDatabaseService, getDatabaseService } from './services/database/databaseService';
import { ModelManager } from './services/model/modelManager';
import { OllamaClient } from './services/model/ollamaClient';
import { PendingEditDecorationProvider } from './services/pendingEditDecorationProvider';
import { PendingEditReviewService } from './services/review/pendingEditReviewService';
import { TokenManager } from './services/tokenManager';
import { ChatViewProvider } from './views/chatView';

// ---------------------------------------------------------------------------
// Service container — single object holding all extension-wide services.
// Replaces scattered module-level declarations.
// ---------------------------------------------------------------------------

interface ServiceContainer {
  client: OllamaClient;
  tokenManager: TokenManager;
  modelManager: ModelManager;
  taskTracker: TaskTracker;
  sessionManager: SessionManager;
  pendingEditDecorationProvider: PendingEditDecorationProvider;
  pendingEditReviewService: PendingEditReviewService;
  statusBarItem: vscode.StatusBarItem;
  outputChannel: vscode.OutputChannel;
  completionProvider?: CompletionProvider;
}

let services: ServiceContainer | null = null;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext) {
  console.log('Ollama Copilot is activating...');

  try {
    services = await initCoreServices(context);
    registerFileDecorations(context, services);
    registerReviewService(context, services);
    fireAndForgetConnectionCheck(services);
    registerStatusBar(context, services);
    registerCompletionProvider(context, services);
    registerCommands(context, services);
    const chatViewProvider = await registerChatView(context, services);
    await registerModes(context, services);
    checkFirstRun(context, chatViewProvider);

    console.log('Ollama Copilot activated successfully!');
  } catch (error: any) {
    console.error('Failed to activate Ollama Copilot:', error);
    vscode.window.showErrorMessage(`Ollama Copilot activation failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export async function deactivate() {
  console.log('Ollama Copilot deactivating...');

  if (services) {
    try {
      const db = getDatabaseService();
      await db.resetGeneratingSessions('idle');
    } catch (error) {
      console.error('Failed to reset generating sessions on deactivate:', error);
    }

    services.client.dispose();
    services.modelManager.clearCache();
  }

  disposeDatabaseService();
  services = null;
}

// ---------------------------------------------------------------------------
// Initialization helpers
// ---------------------------------------------------------------------------

async function initCoreServices(context: vscode.ExtensionContext): Promise<ServiceContainer> {
  const config = getConfig();
  const tokenManager = new TokenManager(context);
  const bearerToken = await tokenManager.getToken();

  const client = new OllamaClient(config.baseUrl, bearerToken);
  const modelManager = new ModelManager(client);

  const databaseService = getDatabaseService(context);
  await databaseService.initialize(client);
  modelManager.setDatabaseService(databaseService);

  return {
    client,
    tokenManager,
    modelManager,
    taskTracker: new TaskTracker(context),
    sessionManager: new SessionManager(context),
    outputChannel: vscode.window.createOutputChannel('Ollama Copilot'),
    pendingEditDecorationProvider: new PendingEditDecorationProvider(),
    pendingEditReviewService: new PendingEditReviewService(databaseService),
    statusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
  };
}

function registerFileDecorations(context: vscode.ExtensionContext, s: ServiceContainer): void {
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(s.pendingEditDecorationProvider)
  );

  // Restore pending edit decorations from DB (fire-and-forget)
  const db = getDatabaseService();
  db.getPendingCheckpoints().then(checkpoints => {
    for (const ckpt of checkpoints) {
      for (const snap of ckpt.files) {
        try {
          s.pendingEditDecorationProvider.markPending(vscode.Uri.file(snap.file_path));
        } catch { /* skip invalid paths */ }
      }
    }
  }).catch(() => { /* ignore — non-critical */ });
}

function registerReviewService(context: vscode.ExtensionContext, s: ServiceContainer): void {
  context.subscriptions.push(s.pendingEditReviewService);

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCopilot.reviewNextFile', () => s.pendingEditReviewService.navigateFile('next')),
    vscode.commands.registerCommand('ollamaCopilot.reviewPrevFile', () => s.pendingEditReviewService.navigateFile('prev')),
    vscode.commands.registerCommand('ollamaCopilot.reviewNextHunk', () => s.pendingEditReviewService.navigateHunk('next')),
    vscode.commands.registerCommand('ollamaCopilot.reviewPrevHunk', () => s.pendingEditReviewService.navigateHunk('prev')),
    vscode.commands.registerCommand('ollamaCopilot.reviewKeepHunk', (filePath: string, hunkIndex: number) => s.pendingEditReviewService.keepHunk(filePath, hunkIndex)),
    vscode.commands.registerCommand('ollamaCopilot.reviewUndoHunk', (filePath: string, hunkIndex: number) => s.pendingEditReviewService.undoHunk(filePath, hunkIndex)),
    vscode.commands.registerCommand('ollamaCopilot.reviewKeepCurrentHunk', () => s.pendingEditReviewService.keepCurrentHunk()),
    vscode.commands.registerCommand('ollamaCopilot.reviewUndoCurrentHunk', () => s.pendingEditReviewService.undoCurrentHunk()),
    vscode.commands.registerCommand('ollamaCopilot.reviewCloseReview', () => s.pendingEditReviewService.closeReview())
  );
}

function fireAndForgetConnectionCheck(s: ServiceContainer): void {
  const config = getConfig();
  s.client.testConnection().then(connected => {
    if (!connected) {
      vscode.window.showWarningMessage(
        `Cannot connect to Ollama at ${config.baseUrl}. Please ensure it's running.`,
        'Open Settings'
      ).then(choice => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaCopilot');
        }
      });
    }
  }).catch(() => { /* non-fatal */ });
}

function registerStatusBar(context: vscode.ExtensionContext, s: ServiceContainer): void {
  s.statusBarItem.command = 'ollamaCopilot.selectModel';
  s.statusBarItem.text = '$(robot) Ollama';
  s.statusBarItem.tooltip = 'Click to select model';
  s.statusBarItem.show();
  context.subscriptions.push(s.statusBarItem);
}

function registerCompletionProvider(context: vscode.ExtensionContext, s: ServiceContainer): void {
  const completionConfig = getModeConfig('completion');
  if (completionConfig.model) {
    s.completionProvider = new CompletionProvider(s.client, completionConfig);
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        s.completionProvider
      )
    );
    console.log('Inline completion provider registered');
  }
}

function registerCommands(context: vscode.ExtensionContext, s: ServiceContainer): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCopilot.selectModel', async () => {
      const selected = await s.modelManager.selectModel();
      if (selected) {
        await vscode.workspace.getConfiguration('ollamaCopilot')
          .update('completionMode.model', selected, vscode.ConfigurationTarget.Global);
        s.statusBarItem.text = `$(robot) ${selected}`;
        vscode.window.showInformationMessage(`Model set to: ${selected}`);

        if (s.completionProvider) {
          s.completionProvider.updateConfig(getModeConfig('completion'));
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCopilot.setBearerToken', async () => {
      await s.tokenManager.manageToken();
      const newToken = await s.tokenManager.getToken();
      s.client.setBearerToken(newToken);

      const hasToken = await s.tokenManager.hasToken();
      await vscode.workspace.getConfiguration('ollamaCopilot')
        .update('bearerTokenConfigured', hasToken, vscode.ConfigurationTarget.Global);
    })
  );
}

async function registerChatView(context: vscode.ExtensionContext, s: ServiceContainer): Promise<ChatViewProvider> {
  const databaseService = getDatabaseService();
  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    s.client,
    s.modelManager,
    s.tokenManager,
    s.sessionManager,
    databaseService,
    s.pendingEditDecorationProvider,
    s.pendingEditReviewService
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
  );

  // showSetup command opens the sidebar settings page
  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCopilot.showSetup', () => {
      chatViewProvider.navigateToSettings(true);
    })
  );

  return chatViewProvider;
}

async function registerModes(context: vscode.ExtensionContext, s: ServiceContainer): Promise<void> {
  await registerPlanMode(context, s.client, s.taskTracker);
  registerAgentMode(context, s.client, s.sessionManager, s.outputChannel);
  await registerEditMode(context, s.client);
}

function checkFirstRun(context: vscode.ExtensionContext, chatViewProvider: ChatViewProvider): void {
  const isFirstRun = !context.globalState.get('setupCompleted');
  if (isFirstRun) {
    context.globalState.update('setupCompleted', true);
    chatViewProvider.navigateToSettings(true);
  }
}
