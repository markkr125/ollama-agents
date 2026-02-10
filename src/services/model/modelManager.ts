import * as vscode from 'vscode';
import { Model } from '../../types/ollama';
import { DatabaseService } from '../database/databaseService';
import { checkModelCompatibility } from './modelCompatibility';
import { OllamaClient } from './ollamaClient';

export class ModelManager {
  private cache: { models: Model[]; timestamp: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private databaseService: DatabaseService | null = null;

  constructor(private client: OllamaClient) {}

  /**
   * Set the DatabaseService for SQLite-backed model cache fallback.
   * Called after DatabaseService is initialised.
   */
  setDatabaseService(db: DatabaseService): void {
    this.databaseService = db;
  }

  /**
   * Fetch models from Ollama/OpenWebUI with caching.
   * Falls back to in-memory cache, then SQLite cache, then empty.
   */
  async fetchModels(forceRefresh = false): Promise<Model[]> {
    const now = Date.now();

    if (!forceRefresh && this.cache && now - this.cache.timestamp < this.CACHE_TTL) {
      return this.cache.models;
    }

    try {
      const models = await this.client.listModels();
      // Merge cached capabilities from SQLite (fast offline fallback)
      if (this.databaseService) {
        try {
          const cached = await this.databaseService.getCachedModels();
          const capMap = new Map(cached.filter(m => m.capabilities).map(m => [m.name, m.capabilities!]));
          for (const model of models) {
            if (!model.capabilities) {
              const caps = capMap.get(model.name);
              if (caps) model.capabilities = caps;
            }
          }
        } catch { /* ignore */ }
      }
      this.cache = { models, timestamp: now };
      // Persist to SQLite (fire-and-forget)
      this.databaseService?.upsertModels(models).catch(err =>
        console.warn('[ModelManager] Failed to cache models:', err)
      );
      return models;
    } catch (error: any) {
      // In-memory cache first
      if (this.cache?.models?.length) {
        return this.cache.models;
      }
      // SQLite fallback
      if (this.databaseService) {
        try {
          const cached = await this.databaseService.getCachedModels();
          if (cached.length > 0) {
            return cached;
          }
        } catch { /* ignore */ }
      }
      vscode.window.showErrorMessage(`Failed to fetch models: ${error.message}`);
      return [];
    }
  }

  /**
   * Show model selection quick pick
   */
  async selectModel(currentModel?: string): Promise<string | undefined> {
    const models = await this.fetchModels();

    if (models.length === 0) {
      vscode.window.showWarningMessage('No models available. Make sure Ollama is running.');
      return undefined;
    }

    const items = models.map(model => ({
      label: model.name,
      description: this.formatSize(model.size),
      detail: `Modified: ${this.formatDate(model.modified_at)}`,
      picked: model.name === currentModel
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a model',
      matchOnDescription: true,
      matchOnDetail: true,
      title: 'Ollama Models'
    });

    return selected?.label;
  }

  /**
   * Validate model for specific mode
   */
  async validateModelForMode(
    modelName: string,
    mode: 'completion' | 'agent'
  ): Promise<boolean> {
    if (!modelName) {
      return true; // Allow empty (will use default or prompt)
    }

    // Try to find the full Model object in cache for accurate capability check
    const models = await this.fetchModels();
    const model = models.find(m => m.name === modelName);
    if (!model) {
      return true; // Model not found in cache — allow it
    }

    const requiredCapability = mode === 'completion' ? 'fim' : 'tool';
    const check = checkModelCompatibility(model, requiredCapability);

    if (!check.compatible && check.warning) {
      const choice = await vscode.window.showWarningMessage(
        check.warning,
        'Use Anyway',
        'Select Different Model'
      );

      if (choice === 'Select Different Model') {
        return false;
      }
    }

    return true;
  }

  /**
   * Format size in human-readable format
   */
  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Format date in relative format
   */
  private formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  /**
   * Clear model cache
   */
  clearCache(): void {
    this.cache = null;
  }
}
