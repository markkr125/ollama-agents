import * as vscode from 'vscode';
import { SessionManager } from './agent/sessionManager';
import { TaskTracker } from './agent/taskTracker';
import { getConfig, getModeConfig } from './config/settings';
import { registerAgentMode } from './modes/agentMode';
import { registerEditMode } from './modes/editMode';
import { registerPlanMode } from './modes/planMode';
import { CompletionProvider } from './providers/completionProvider';
import { DatabaseService, disposeDatabaseService, getDatabaseService } from './services/database/databaseService';
import { ModelManager } from './services/model/modelManager';
import { OllamaClient } from './services/model/ollamaClient';
import { PendingEditDecorationProvider } from './services/pendingEditDecorationProvider';
import { PendingEditReviewService } from './services/review/pendingEditReviewService';
import { TokenManager } from './services/tokenManager';
import { ChatViewProvider } from './views/chatView';

let client: OllamaClient;
let tokenManager: TokenManager;
let modelManager: ModelManager;
let databaseService: DatabaseService;
let taskTracker: TaskTracker;
let sessionManager: SessionManager;
let completionProvider: CompletionProvider | undefined;
let pendingEditDecorationProvider: PendingEditDecorationProvider;
let pendingEditReviewService: PendingEditReviewService;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Ollama Copilot is activating...');

  try {
    // Initialize core services
    const config = getConfig();
    tokenManager = new TokenManager(context);
    const bearerToken = await tokenManager.getToken();
    
    client = new OllamaClient(config.baseUrl, bearerToken);
    modelManager = new ModelManager(client);
    
    // Initialize database service
    databaseService = getDatabaseService(context);
    await databaseService.initialize(client);

    // Wire database service into model manager for SQLite-backed cache fallback
    modelManager.setDatabaseService(databaseService);
    
    taskTracker = new TaskTracker(context);
    sessionManager = new SessionManager(context);
    outputChannel = vscode.window.createOutputChannel('Ollama Copilot');

    // Register file decoration provider for pending AI edits
    pendingEditDecorationProvider = new PendingEditDecorationProvider();
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(pendingEditDecorationProvider)
    );

    // Restore pending edit decorations from DB (fire-and-forget)
    databaseService.getPendingCheckpoints().then(checkpoints => {
      for (const ckpt of checkpoints) {
        for (const snap of ckpt.files) {
          try {
            const fileUri = vscode.Uri.file(snap.file_path);
            pendingEditDecorationProvider.markPending(fileUri);
          } catch { /* skip invalid paths */ }
        }
      }
    }).catch(() => { /* ignore — non-critical */ });

    // Create review service for inline change decorations
    pendingEditReviewService = new PendingEditReviewService(databaseService);
    context.subscriptions.push(pendingEditReviewService);

    // Register review navigation commands
    context.subscriptions.push(
      vscode.commands.registerCommand('ollamaCopilot.reviewNextFile', () => pendingEditReviewService.navigateFile('next')),
      vscode.commands.registerCommand('ollamaCopilot.reviewPrevFile', () => pendingEditReviewService.navigateFile('prev')),
      vscode.commands.registerCommand('ollamaCopilot.reviewNextHunk', () => pendingEditReviewService.navigateHunk('next')),
      vscode.commands.registerCommand('ollamaCopilot.reviewPrevHunk', () => pendingEditReviewService.navigateHunk('prev')),
      vscode.commands.registerCommand('ollamaCopilot.reviewKeepHunk', (filePath: string, hunkIndex: number) => pendingEditReviewService.keepHunk(filePath, hunkIndex)),
      vscode.commands.registerCommand('ollamaCopilot.reviewUndoHunk', (filePath: string, hunkIndex: number) => pendingEditReviewService.undoHunk(filePath, hunkIndex)),
      vscode.commands.registerCommand('ollamaCopilot.reviewKeepCurrentHunk', () => pendingEditReviewService.keepCurrentHunk()),
      vscode.commands.registerCommand('ollamaCopilot.reviewUndoCurrentHunk', () => pendingEditReviewService.undoCurrentHunk()),
      vscode.commands.registerCommand('ollamaCopilot.reviewCloseReview', () => pendingEditReviewService.closeReview())
    );

    // Test connection (fire-and-forget — don't block activation)
    client.testConnection().then(connected => {
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

    // Create status bar item for model selection
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.command = 'ollamaCopilot.selectModel';
    statusBarItem.text = '$(robot) Ollama';
    statusBarItem.tooltip = 'Click to select model';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register inline completion provider
    const completionConfig = getModeConfig('completion');
    if (completionConfig.model) {
      completionProvider = new CompletionProvider(client, completionConfig);
      context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
          { pattern: '**' },
          completionProvider
        )
      );
      console.log('Inline completion provider registered');
    }

    // Register commands
    context.subscriptions.push(
      vscode.commands.registerCommand('ollamaCopilot.selectModel', async () => {
        const selected = await modelManager.selectModel();
        if (selected) {
          await vscode.workspace.getConfiguration('ollamaCopilot')
            .update('completionMode.model', selected, vscode.ConfigurationTarget.Global);
          statusBarItem.text = `$(robot) ${selected}`;
          vscode.window.showInformationMessage(`Model set to: ${selected}`);
          
          // Update completion provider config
          if (completionProvider) {
            completionProvider.updateConfig(getModeConfig('completion'));
          }
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('ollamaCopilot.setBearerToken', async () => {
        await tokenManager.manageToken();
        const newToken = await tokenManager.getToken();
        client.setBearerToken(newToken);
        
        // Update the read-only status indicator in settings
        const hasToken = await tokenManager.hasToken();
        await vscode.workspace.getConfiguration('ollamaCopilot')
          .update('bearerTokenConfigured', hasToken, vscode.ConfigurationTarget.Global);
      })
    );

    // Register chat view in sidebar
    const chatViewProvider = new ChatViewProvider(
      context.extensionUri,
      client,
      modelManager,
      tokenManager,
      sessionManager,
      databaseService,
      pendingEditDecorationProvider,
      pendingEditReviewService
    );
    
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ChatViewProvider.viewType,
        chatViewProvider
      )
    );

    await registerPlanMode(context, client, taskTracker);

    // Register Agent mode
    registerAgentMode(context, client, sessionManager, outputChannel);


    // Register Edit mode
    await registerEditMode(context, client);

    // Register showSetup command — opens the sidebar settings page
    context.subscriptions.push(
      vscode.commands.registerCommand('ollamaCopilot.showSetup', () => {
        chatViewProvider.navigateToSettings(true);
      })
    );

    // Check for first run
    const isFirstRun = !context.globalState.get('setupCompleted');
    if (isFirstRun) {
      await context.globalState.update('setupCompleted', true);
      chatViewProvider.navigateToSettings(true);
    }

    console.log('Ollama Copilot activated successfully!');

  } catch (error: any) {
    console.error('Failed to activate Ollama Copilot:', error);
    vscode.window.showErrorMessage(`Ollama Copilot activation failed: ${error.message}`);
  }
}

export async function deactivate() {
  console.log('Ollama Copilot deactivating...');

  if (databaseService) {
    try {
      await databaseService.resetGeneratingSessions('idle');
    } catch (error) {
      console.error('Failed to reset generating sessions on deactivate:', error);
    }
  }
  
  if (client) {
    client.dispose();
  }

  if (modelManager) {
    modelManager.clearCache();
  }

  // Close database connection
  disposeDatabaseService();
}
