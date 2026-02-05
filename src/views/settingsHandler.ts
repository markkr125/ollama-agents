import * as vscode from 'vscode';
import { getConfig } from '../config/settings';
import { DatabaseService } from '../services/databaseService';
import { OllamaClient } from '../services/ollamaClient';
import { TokenManager } from '../services/tokenManager';
import { WebviewMessageEmitter } from './chatTypes';

export class SettingsHandler {
  constructor(
    private readonly client: OllamaClient,
    private readonly tokenManager: TokenManager,
    private readonly databaseService: DatabaseService,
    private readonly emitter: WebviewMessageEmitter
  ) {}

  getSettingsPayload() {
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
      temperature: config.agentMode.temperature,
      sensitiveFilePatterns: JSON.stringify(config.agent.sensitiveFilePatterns, null, 2)
    };
  }

  async sendSettingsUpdate() {
    const settings = this.getSettingsPayload();
    this.client.setBaseUrl(settings.baseUrl);
    const hasToken = await this.tokenManager.hasToken();
    this.emitter.postMessage({
      type: 'settingsUpdate',
      settings,
      hasToken
    });
  }

  async saveSettings(settings: any) {
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
    if (settings.sensitiveFilePatterns !== undefined) {
      try {
        const parsed = typeof settings.sensitiveFilePatterns === 'string'
          ? JSON.parse(settings.sensitiveFilePatterns)
          : settings.sensitiveFilePatterns;
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Sensitive file patterns must be a JSON object.');
        }
        await config.update('agent.sensitiveFilePatterns', parsed, vscode.ConfigurationTarget.Global);
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Failed to save sensitive file patterns: ${error?.message || 'Invalid JSON'}`
        );
      }
    }

    this.emitter.postMessage({ type: 'settingsSaved' });
    await this.sendSettingsUpdate();
  }

  async testConnection() {
    try {
      const models = await this.client.listModels();
      this.emitter.postMessage({
        type: 'connectionTestResult',
        success: true,
        message: 'Connected successfully!',
        models
      });
    } catch (error: any) {
      this.emitter.postMessage({
        type: 'connectionTestResult',
        success: false,
        message: error.message
      });
    }
  }

  async saveBearerToken(token: string, testAfterSave?: boolean) {
    if (token) {
      await this.tokenManager.setToken(token);
      this.client.setBearerToken(token);
    } else {
      await this.tokenManager.deleteToken();
      this.client.setBearerToken(undefined);
    }
    this.emitter.postMessage({
      type: 'bearerTokenSaved',
      hasToken: !!token
    });

    if (testAfterSave) {
      await this.testConnection();
    }
  }

  async runDbMaintenance() {
    try {
      const result = await this.databaseService.runMaintenance();
      this.emitter.postMessage({
        type: 'dbMaintenanceResult',
        success: true,
        deletedSessions: result.deletedSessions,
        deletedMessages: result.deletedMessages
      });
    } catch (error: any) {
      this.emitter.postMessage({
        type: 'dbMaintenanceResult',
        success: false,
        message: error?.message || 'Database maintenance failed.'
      });
    }
  }

  async recreateMessagesTable() {
    // Show VS Code confirmation dialog
    const confirmed = await vscode.window.showWarningMessage(
      '⚠️ This will permanently delete ALL chat history! Are you sure?',
      { modal: true },
      'Delete All Messages'
    );

    if (confirmed !== 'Delete All Messages') {
      this.emitter.postMessage({
        type: 'recreateMessagesResult',
        success: false,
        message: 'Operation cancelled.'
      });
      return;
    }

    try {
      await this.databaseService.recreateMessagesTable();
      this.emitter.postMessage({
        type: 'recreateMessagesResult',
        success: true,
        message: 'Messages table recreated successfully. All message history has been cleared.'
      });
      // Refresh UI: clear sessions list
      this.emitter.postMessage({
        type: 'loadSessions',
        sessions: [],
        hasMore: false,
        nextOffset: null
      });
    } catch (error: any) {
      this.emitter.postMessage({
        type: 'recreateMessagesResult',
        success: false,
        message: error?.message || 'Failed to recreate messages table.'
      });
    }
  }
}
