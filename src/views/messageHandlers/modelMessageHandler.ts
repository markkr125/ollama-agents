import { DatabaseService } from '../../services/database/databaseService';
import { OllamaClient } from '../../services/model/ollamaClient';
import { Model } from '../../types/ollama';
import { IMessageHandler, WebviewMessageEmitter } from '../chatTypes';
import { enrichModels } from '../settingsHandler';

/**
 * Merge capabilities and enabled state from SQLite cache into freshly-listed models.
 * Avoids showing blank capabilities before /api/show runs.
 */
export async function mergeCachedCapabilities(databaseService: DatabaseService, models: Model[]): Promise<void> {
  try {
    const cached = await databaseService.getCachedModels();
    const cacheMap = new Map(cached.map(m => [m.name, m]));
    for (const model of models) {
      const c = cacheMap.get(model.name);
      if (c) {
        if (!model.capabilities && c.capabilities) model.capabilities = c.capabilities;
        if (model.enabled === undefined && c.enabled !== undefined) model.enabled = c.enabled;
      }
    }
  } catch { /* ignore cache errors */ }
}

/**
 * Handles model management messages: capability refresh, enable/disable toggle.
 */
export class ModelMessageHandler implements IMessageHandler {
  readonly handledTypes = ['refreshCapabilities', 'toggleModelEnabled', 'updateModelMaxContext'] as const;

  private capabilityRefreshInProgress = false;

  constructor(
    private readonly emitter: WebviewMessageEmitter,
    private readonly client: OllamaClient,
    private readonly databaseService: DatabaseService
  ) {}

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'refreshCapabilities':
        await this.refreshCapabilities(false);
        break;
      case 'toggleModelEnabled':
        await this.handleToggleModelEnabled(data.modelName, !!data.enabled);
        break;
      case 'updateModelMaxContext':
        await this.handleUpdateModelMaxContext(data.modelName, data.maxContext);
        break;
    }
  }

  /**
   * Background capability refresh: calls /api/show for each model sequentially.
   * Public so ChatMessageHandler can call it from initialize().
   * @param onlyMissing If true, skip models that already have cached capabilities.
   */
  async refreshCapabilities(onlyMissing = false) {
    if (this.capabilityRefreshInProgress) return;
    this.capabilityRefreshInProgress = true;

    try {
      let models: Model[];
      try {
        models = await this.client.listModels();
        await mergeCachedCapabilities(this.databaseService, models);
      } catch {
        // Fall back to cached models
        try { models = await this.databaseService.getCachedModels(); } catch { models = []; }
      }

      // Determine which models need /api/show
      const indicesToFetch = models
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !onlyMissing || !m.capabilities)
        .map(({ i }) => i);

      if (indicesToFetch.length === 0) {
        // Nothing to fetch — send current state and finish
        this.emitter.postMessage({ type: 'capabilityCheckComplete' });
        return;
      }

      const total = indicesToFetch.length;
      this.emitter.postMessage({ type: 'capabilityCheckProgress', completed: 0, total });

      for (let step = 0; step < indicesToFetch.length; step++) {
        const i = indicesToFetch[step];
        try {
          const showResult = await this.client.showModel(models[i].name);
          if (showResult.capabilities) {
            models[i].capabilities = showResult.capabilities;
          }
        } catch {
          // On error (401, network, etc.), keep existing cached capabilities
        }

        // Send progress update with enriched models so far
        this.emitter.postMessage({
          type: 'capabilityCheckProgress',
          completed: step + 1,
          total,
          models: enrichModels(models)
        });
      }

      // Persist fully enriched models to SQLite
      this.databaseService.upsertModels(models).catch(err =>
        console.warn('[ModelHandler] Failed to cache models after capability refresh:', err)
      );

      this.emitter.postMessage({ type: 'capabilityCheckComplete' });
    } catch (error: any) {
      console.warn('[ModelHandler] Capability refresh failed:', error);
      this.emitter.postMessage({ type: 'capabilityCheckComplete' });
    } finally {
      this.capabilityRefreshInProgress = false;
    }
  }

  private async handleToggleModelEnabled(modelName: string, enabled: boolean) {
    if (!modelName) return;
    await this.databaseService.setModelEnabled(modelName, enabled);
    let models: Model[];
    try {
      models = await this.databaseService.getCachedModels();
    } catch {
      return;
    }
    this.emitter.postMessage({ type: 'modelEnabledChanged', models: enrichModels(models) });
  }

  private async handleUpdateModelMaxContext(modelName: string, maxContext: number | null) {
    if (!modelName) return;
    await this.databaseService.setModelMaxContext(modelName, maxContext);
    let models: Model[];
    try {
      models = await this.databaseService.getCachedModels();
    } catch {
      return;
    }
    this.emitter.postMessage({ type: 'modelEnabledChanged', models: enrichModels(models) });
  }
}
