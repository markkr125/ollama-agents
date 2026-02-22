import * as assert from 'assert';

/**
 * Tests for explorer model resolution — the 3-tier fallback chain that
 * determines which model to use for sub-agent tasks:
 *
 *   1. Session-level override (per-session explorerModel)
 *   2. Global setting (ollamaCopilot.agent.explorerModel)
 *   3. Same model as the orchestrator
 *
 * Also tests the capability cache and resolveExplorerCapabilities logic.
 *
 * Since resolveExplorerCapabilities lives inside AgentChatExecutor and
 * depends on OllamaClient + DatabaseService, we test the pure logic
 * by replicating the resolution algorithm with stub services.
 */

import { ModelCapabilities } from '../../../../src/services/model/modelCompatibility';

// ── Replicate the resolution logic from agentChatExecutor.ts ──────

class StubExplorerCapabilityResolver {
  private cache = new Map<string, ModelCapabilities>();
  private dbModels: Array<{ name: string; capabilities: string[] }>;
  private showModelResults: Map<string, { capabilities: string[]; contextLength?: number }>;
  private showModelErrors: Set<string>;

  constructor(opts: {
    dbModels?: Array<{ name: string; capabilities: string[] }>;
    showModelResults?: Map<string, { capabilities: string[]; contextLength?: number }>;
    showModelErrors?: Set<string>;
  } = {}) {
    this.dbModels = opts.dbModels || [];
    this.showModelResults = opts.showModelResults || new Map();
    this.showModelErrors = opts.showModelErrors || new Set();
  }

  async resolveExplorerCapabilities(explorerModel: string): Promise<ModelCapabilities | undefined> {
    const cached = this.cache.get(explorerModel);
    if (cached) return cached;

    // Try DB cache first
    try {
      const record = this.dbModels.find(m => m.name === explorerModel);
      if (record) {
        const caps: ModelCapabilities = {
          chat: true,
          fim: false,
          tools: record.capabilities.includes('tools'),
          vision: record.capabilities.includes('vision'),
          embedding: false,
        };
        this.cache.set(explorerModel, caps);
        return caps;
      }
    } catch { /* fall through */ }

    // Try live /api/show
    try {
      if (this.showModelErrors.has(explorerModel)) {
        throw new Error(`Model not found: ${explorerModel}`);
      }
      const showResult = this.showModelResults.get(explorerModel);
      if (showResult) {
        const caps: ModelCapabilities = {
          chat: true,
          fim: false,
          tools: showResult.capabilities.includes('tools'),
          vision: showResult.capabilities.includes('vision'),
          embedding: false,
          contextLength: showResult.contextLength,
        };
        this.cache.set(explorerModel, caps);
        return caps;
      }
      throw new Error('Not found');
    } catch {
      return undefined;
    }
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Replicate the 3-tier explorer model fallback from chatMessageHandler.ts
 */
function resolveExplorerModel(opts: {
  sessionExplorerModel?: string;
  settingExplorerModel: string;
  orchestratorModel: string;
}): string {
  // Tier 1: Session-level override
  if (opts.sessionExplorerModel) return opts.sessionExplorerModel;
  // Tier 2: Global setting
  if (opts.settingExplorerModel) return opts.settingExplorerModel;
  // Tier 3: Same as orchestrator
  return opts.orchestratorModel;
}

// ── Tests ────────────────────────────────────────────────────────────

suite('Explorer model resolution', () => {

  suite('3-tier fallback chain', () => {
    test('tier 1: session-level override takes precedence', () => {
      const model = resolveExplorerModel({
        sessionExplorerModel: 'qwen3:8b',
        settingExplorerModel: 'llama3.3:latest',
        orchestratorModel: 'deepseek-r1:70b',
      });
      assert.strictEqual(model, 'qwen3:8b');
    });

    test('tier 2: global setting used when no session override', () => {
      const model = resolveExplorerModel({
        sessionExplorerModel: undefined,
        settingExplorerModel: 'llama3.3:latest',
        orchestratorModel: 'deepseek-r1:70b',
      });
      assert.strictEqual(model, 'llama3.3:latest');
    });

    test('tier 2: empty string session override falls through to setting', () => {
      const model = resolveExplorerModel({
        sessionExplorerModel: '',
        settingExplorerModel: 'llama3.3:latest',
        orchestratorModel: 'deepseek-r1:70b',
      });
      assert.strictEqual(model, 'llama3.3:latest');
    });

    test('tier 3: same as orchestrator when nothing configured', () => {
      const model = resolveExplorerModel({
        sessionExplorerModel: undefined,
        settingExplorerModel: '',
        orchestratorModel: 'deepseek-r1:70b',
      });
      assert.strictEqual(model, 'deepseek-r1:70b');
    });

    test('tier 3: both overrides empty → orchestrator model', () => {
      const model = resolveExplorerModel({
        sessionExplorerModel: '',
        settingExplorerModel: '',
        orchestratorModel: 'codestral:latest',
      });
      assert.strictEqual(model, 'codestral:latest');
    });
  });

  suite('capability resolution (DB cache)', () => {
    test('resolves capabilities from DB cache', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        dbModels: [{ name: 'qwen3:8b', capabilities: ['tools', 'vision'] }],
      });
      const caps = await resolver.resolveExplorerCapabilities('qwen3:8b');
      assert.ok(caps, 'Should resolve capabilities');
      assert.strictEqual(caps!.tools, true);
      assert.strictEqual(caps!.vision, true);
      assert.strictEqual(caps!.chat, true);
      assert.strictEqual(caps!.embedding, false);
    });

    test('model without tools capability', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        dbModels: [{ name: 'phi4:latest', capabilities: [] }],
      });
      const caps = await resolver.resolveExplorerCapabilities('phi4:latest');
      assert.ok(caps);
      assert.strictEqual(caps!.tools, false);
      assert.strictEqual(caps!.vision, false);
    });
  });

  suite('capability resolution (live /api/show fallback)', () => {
    test('falls back to /api/show when not in DB', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        dbModels: [],
        showModelResults: new Map([
          ['qwen3:8b', { capabilities: ['tools'], contextLength: 32768 }],
        ]),
      });
      const caps = await resolver.resolveExplorerCapabilities('qwen3:8b');
      assert.ok(caps);
      assert.strictEqual(caps!.tools, true);
      assert.strictEqual(caps!.contextLength, 32768);
    });

    test('returns undefined when both DB and /api/show fail', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        dbModels: [],
        showModelErrors: new Set(['nonexistent:model']),
      });
      const caps = await resolver.resolveExplorerCapabilities('nonexistent:model');
      assert.strictEqual(caps, undefined);
    });
  });

  suite('capability cache', () => {
    test('caches result from DB on second call', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        dbModels: [{ name: 'qwen3:8b', capabilities: ['tools'] }],
      });
      const caps1 = await resolver.resolveExplorerCapabilities('qwen3:8b');
      assert.strictEqual(resolver.getCacheSize(), 1, 'Cache should have 1 entry after first call');

      const caps2 = await resolver.resolveExplorerCapabilities('qwen3:8b');
      assert.strictEqual(caps1, caps2, 'Should return same cached object');
    });

    test('caches result from /api/show', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        showModelResults: new Map([
          ['llama3.3:latest', { capabilities: ['tools', 'vision'], contextLength: 128000 }],
        ]),
      });
      await resolver.resolveExplorerCapabilities('llama3.3:latest');
      assert.strictEqual(resolver.getCacheSize(), 1);

      // Second call uses cache (even if we remove it from showModelResults)
      const caps = await resolver.resolveExplorerCapabilities('llama3.3:latest');
      assert.ok(caps);
      assert.strictEqual(caps!.tools, true);
    });

    test('does NOT cache failed resolution', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        showModelErrors: new Set(['fail-model']),
      });
      await resolver.resolveExplorerCapabilities('fail-model');
      assert.strictEqual(resolver.getCacheSize(), 0, 'Failed resolution should not be cached');
    });

    test('caches separately for different models', async () => {
      const resolver = new StubExplorerCapabilityResolver({
        dbModels: [
          { name: 'model-a', capabilities: ['tools'] },
          { name: 'model-b', capabilities: [] },
        ],
      });
      const capsA = await resolver.resolveExplorerCapabilities('model-a');
      const capsB = await resolver.resolveExplorerCapabilities('model-b');
      assert.strictEqual(resolver.getCacheSize(), 2);
      assert.strictEqual(capsA!.tools, true);
      assert.strictEqual(capsB!.tools, false);
    });
  });
});
