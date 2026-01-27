import * as path from 'path';
import * as vscode from 'vscode';
import { OllamaClient } from '../services/ollamaClient';
import { TokenManager } from '../services/tokenManager';

export class SetupWizard {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private client: OllamaClient,
    private tokenManager: TokenManager
  ) {}

  /**
   * Show the setup wizard
   */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ollamaCopilotSetup',
      'Ollama Copilot Setup',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.getWebviewContent();

    this.panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'testConnection':
            await this.handleTestConnection(message.baseUrl, message.bearerToken);
            break;

          case 'fetchModels':
            await this.handleFetchModels();
            break;

          case 'saveConfig':
            await this.handleSaveConfig(message.config);
            break;

          case 'loadConfig':
            await this.handleLoadConfig();
            break;

          case 'close':
            this.panel?.dispose();
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      this.context.subscriptions
    );
  }

  /**
   * Test connection to Ollama
   */
  private async handleTestConnection(baseUrl: string, bearerToken: string): Promise<void> {
    try {
      // Temporarily update client config
      const config = vscode.workspace.getConfiguration('ollamaCopilot');
      await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);

      if (bearerToken) {
        await this.tokenManager.setToken(bearerToken);
      }

      // Test connection
      const success = await this.client.testConnection();

      this.panel?.webview.postMessage({
        command: 'connectionResult',
        success,
        error: success ? undefined : 'Could not connect'
      });

    } catch (error: any) {
      this.panel?.webview.postMessage({
        command: 'connectionResult',
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Fetch available models
   */
  private async handleFetchModels(): Promise<void> {
    try {
      const models = await this.client.listModels();

      const formatted = models.map(m => ({
        name: m.name,
        size: this.formatSize(m.size)
      }));

      this.panel?.webview.postMessage({
        command: 'modelsResult',
        success: true,
        models: formatted
      });

    } catch (error: any) {
      this.panel?.webview.postMessage({
        command: 'modelsResult',
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Save configuration
   */
  private async handleSaveConfig(configData: any): Promise<void> {
    const config = vscode.workspace.getConfiguration('ollamaCopilot');

    try {
      await config.update('baseUrl', configData.baseUrl, vscode.ConfigurationTarget.Global);
      
      if (configData.bearerToken) {
        await this.tokenManager.setToken(configData.bearerToken);
      }

      // Update mode configurations
      if (configData.completionModel) {
        await config.update('completionMode.model', configData.completionModel, vscode.ConfigurationTarget.Global);
      }

      if (configData.askModel) {
        await config.update('askMode.model', configData.askModel, vscode.ConfigurationTarget.Global);
      }

      if (configData.editModel) {
        await config.update('editMode.model', configData.editModel, vscode.ConfigurationTarget.Global);
      }

      if (configData.planModel) {
        await config.update('planMode.model', configData.planModel, vscode.ConfigurationTarget.Global);
      }

      if (configData.agentModel) {
        await config.update('agentMode.model', configData.agentModel, vscode.ConfigurationTarget.Global);
      }

      // Update preferences
      if (typeof configData.temperature === 'number') {
        await config.update('completionMode.temperature', configData.temperature, vscode.ConfigurationTarget.Global);
      }

      vscode.window.showInformationMessage('✅ Ollama Copilot configured successfully!');

    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to save configuration: ${error.message}`);
    }
  }

  /**
   * Load current configuration
   */
  private async handleLoadConfig(): Promise<void> {
    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    const hasToken = await this.tokenManager.hasToken();

    this.panel?.webview.postMessage({
      command: 'loadConfig',
      config: {
        baseUrl: config.get('baseUrl'),
        hasToken,
        temperature: config.get('completionMode.temperature'),
        autoComplete: true,
        streamResponse: true
      }
    });
  }

  /**
   * Get webview HTML content
   */
  private getWebviewContent(): string {
    const htmlPath = path.join(this.context.extensionPath, 'src', 'webview', 'setupWizard.html');

    try {
      const fs = require('fs');
      return fs.readFileSync(htmlPath, 'utf8');
    } catch (error) {
      // Fallback if file not found
      return `<!DOCTYPE html>
        <html>
          <head><title>Setup Wizard</title></head>
          <body>
            <h1>Ollama Copilot Setup</h1>
            <p>Setup wizard could not be loaded.</p>
            <p>Please configure manually in VS Code settings.</p>
          </body>
        </html>`;
    }
  }

  /**
   * Format file size
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) {return `${bytes} B`;}
    if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
    if (bytes < 1024 * 1024 * 1024) {return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;}
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}

/**
 * Register setup wizard command
 */
export function registerSetupWizard(
  context: vscode.ExtensionContext,
  client: OllamaClient,
  tokenManager: TokenManager
): void {
  const wizard = new SetupWizard(context, client, tokenManager);

  const command = vscode.commands.registerCommand(
    'ollamaCopilot.showSetup',
    () => wizard.show()
  );

  context.subscriptions.push(command);
}
