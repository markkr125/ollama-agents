import * as vscode from 'vscode';
import { SessionManager } from './agent/sessionManager';
import { TaskTracker } from './agent/taskTracker';
import { getConfig, getModeConfig } from './config/settings';
import { registerAgentMode } from './modes/agentMode';
import { registerEditMode } from './modes/editMode';
import { registerPlanMode } from './modes/planMode';
import { CompletionProvider } from './providers/completionProvider';
import { DatabaseService, disposeDatabaseService, getDatabaseService } from './services/databaseService';
import { ModelManager } from './services/modelManager';
import { OllamaClient } from './services/ollamaClient';
import { TokenManager } from './services/tokenManager';
import { ChatViewProvider } from './views/chatView';
import { registerSetupWizard } from './webview/setupWizard';

let client: OllamaClient;
let tokenManager: TokenManager;
let modelManager: ModelManager;
let databaseService: DatabaseService;
let taskTracker: TaskTracker;
let sessionManager: SessionManager;
let completionProvider: CompletionProvider | undefined;
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
    
    taskTracker = new TaskTracker(context);
    sessionManager = new SessionManager(context);
    outputChannel = vscode.window.createOutputChannel('Ollama Copilot');

    // Test connection
    const connected = await client.testConnection();
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
      databaseService
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


    // Register setup wizard
    registerSetupWizard(context, client, tokenManager);

    // Register Edit mode
    await registerEditMode(context, client);

    // Check for first run
    const isFirstRun = !context.globalState.get('setupCompleted');
    if (isFirstRun) {
      const choice = await vscode.window.showInformationMessage(
        'Welcome to Ollama Copilot! Would you like to configure it now?',
        'Configure',
        'Later'
      );
      
      if (choice === 'Configure') {
        vscode.commands.executeCommand('ollamaCopilot.showSetup');
      }
      
      await context.globalState.update('setupCompleted', true);
    }

    console.log('Ollama Copilot activated successfully!');

  } catch (error: any) {
    console.error('Failed to activate Ollama Copilot:', error);
    vscode.window.showErrorMessage(`Ollama Copilot activation failed: ${error.message}`);
  }
}

export function deactivate() {
  console.log('Ollama Copilot deactivating...');
  
  if (client) {
    client.dispose();
  }

  if (modelManager) {
    modelManager.clearCache();
  }

  // Close database connection
  disposeDatabaseService();
}
