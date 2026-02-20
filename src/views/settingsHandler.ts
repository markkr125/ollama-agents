import * as vscode from 'vscode';
import { getConfig } from '../config/settings';
import { DatabaseService } from '../services/database/databaseService';
import { getModelCapabilities } from '../services/model/modelCompatibility';
import { OllamaClient } from '../services/model/ollamaClient';
import { TokenManager } from '../services/tokenManager';
import { Model } from '../types/ollama';
import { WebviewMessageEmitter } from './chatTypes';

/**
 * Build enriched model info array with capabilities for the webview.
 */
export function enrichModels(models: Model[]) {
  return models.map(m => {
    const caps = getModelCapabilities(m);
    return {
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size ?? undefined,
      quantizationLevel: m.details?.quantization_level ?? undefined,
      capabilities: caps,
      enabled: m.enabled !== false,
      contextLength: caps.contextLength ?? undefined,
      maxContext: (m as any).maxContext ?? null
    };
  });
}

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
      chatModel: config.chatMode.model,
      completionModel: config.completionMode.model,
      maxIterations: config.agent.maxIterations,
      toolTimeout: config.agent.toolTimeout,
      maxActiveSessions: config.agent.maxActiveSessions,
      enableThinking: config.agent.enableThinking,
      continuationStrategy: config.agent.continuationStrategy,
      temperature: config.agentMode.temperature,
      sensitiveFilePatterns: JSON.stringify(config.agent.sensitiveFilePatterns, null, 2),
      storagePath: config.storagePath,
      maxContextWindow: config.agent.maxContextWindow
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
    if (settings.chatModel !== undefined) {
      await config.update('chatMode.model', settings.chatModel, vscode.ConfigurationTarget.Global);
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
    if (settings.enableThinking !== undefined) {
      await config.update('agent.enableThinking', settings.enableThinking, vscode.ConfigurationTarget.Global);
    }
    if (settings.continuationStrategy !== undefined) {
      await config.update('agent.continuationStrategy', settings.continuationStrategy, vscode.ConfigurationTarget.Global);
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
    if (settings.storagePath !== undefined) {
      await config.update('storagePath', settings.storagePath, vscode.ConfigurationTarget.Global);
    }
    if (settings.maxContextWindow !== undefined) {
      await config.update('agent.maxContextWindow', settings.maxContextWindow, vscode.ConfigurationTarget.Global);
    }

    this.emitter.postMessage({ type: 'settingsSaved' });
    await this.sendSettingsUpdate();
  }

  async testConnection(baseUrl?: string) {
    // Apply base URL if provided (avoids race with concurrent saveSettings)
    if (baseUrl) {
      this.client.setBaseUrl(baseUrl);
    }
    try {
      const models = await this.client.listModels();
      // Merge capabilities from SQLite cache so the table isn't blank
      await this.mergeCachedCapabilities(models);
      // Persist basic model info (fire-and-forget)
      this.databaseService.upsertModels(models).catch(err =>
        console.warn('[SettingsHandler] Failed to cache models:', err)
      );
      this.emitter.postMessage({
        type: 'connectionTestResult',
        success: true,
        message: 'Connected successfully!',
        models: enrichModels(models)
      });
    } catch (error: any) {
      // Fall back to cached models so the UI isn't empty
      let cachedModels: Model[] = [];
      try { cachedModels = await this.databaseService.getCachedModels(); } catch { /* ignore */ }
      this.emitter.postMessage({
        type: 'connectionTestResult',
        success: false,
        message: error.message,
        models: enrichModels(cachedModels)
      });
    }
  }

  /**
   * Merge capabilities from SQLite cache into freshly-listed models.
   * This avoids showing blank capabilities before /api/show runs.
   */
  private async mergeCachedCapabilities(models: Model[]): Promise<void> {
    try {
      const cached = await this.databaseService.getCachedModels();
      const capMap = new Map(cached.filter(m => m.capabilities).map(m => [m.name, m.capabilities!]));
      for (const model of models) {
        if (!model.capabilities) {
          const caps = capMap.get(model.name);
          if (caps) model.capabilities = caps;
        }
      }
    } catch { /* ignore cache errors */ }
  }

  async saveBearerToken(token: string, testAfterSave?: boolean, baseUrl?: string) {
    // Apply base URL if provided (avoids race with concurrent saveSettings)
    if (baseUrl) {
      this.client.setBaseUrl(baseUrl);
    }
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
