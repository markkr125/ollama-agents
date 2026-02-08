import * as assert from 'assert';
import { OllamaClient } from '../../../../src/services/ollamaClient';
import { WebviewMessageEmitter } from '../../../../src/views/chatTypes';
import { SettingsHandler } from '../../../../src/views/settingsHandler';
import { startOllamaMockServer } from '../../mocks/ollamaMockServer';

/**
 * Regression tests for SettingsHandler.
 *
 * Focuses on the race condition where saveBearerToken / testConnection
 * could hit the wrong URL because saveSettings (which updates the client's
 * base URL) runs concurrently and may not have finished yet.
 *
 * The fix: both methods accept an optional `baseUrl` parameter that they
 * apply to the client BEFORE making any API calls.
 */
suite('SettingsHandler (race-condition regression)', () => {
  let messages: any[];
  let emitter: WebviewMessageEmitter;

  setup(() => {
    messages = [];
    emitter = {
      postMessage: (msg: any) => { messages.push(msg); }
    };
  });

  test('testConnection(baseUrl) applies URL before calling API', async () => {
    const server = await startOllamaMockServer();
    try {
      // Start with a WRONG base URL
      const client = new OllamaClient('http://127.0.0.1:1');
      const handler = new SettingsHandler(
        client,
        stubTokenManager(),
        stubDatabaseService(),
        emitter
      );

      // Pass the correct URL as parameter — simulates the fix
      await handler.testConnection(server.baseUrl);

      const result = messages.find(m => m.type === 'connectionTestResult');
      assert.ok(result, 'Should have sent connectionTestResult');
      assert.strictEqual(result.success, true, 'Should connect successfully');
      assert.ok(Array.isArray(result.models), 'Should include models array');
      assert.ok(result.models.length > 0, 'Should have at least one model');
    } finally {
      await server.close();
    }
  });

  test('testConnection() without baseUrl uses existing client URL', async () => {
    const server = await startOllamaMockServer();
    try {
      // Client already has the correct URL
      const client = new OllamaClient(server.baseUrl);
      const handler = new SettingsHandler(
        client,
        stubTokenManager(),
        stubDatabaseService(),
        emitter
      );

      await handler.testConnection();

      const result = messages.find(m => m.type === 'connectionTestResult');
      assert.ok(result);
      assert.strictEqual(result.success, true);
    } finally {
      await server.close();
    }
  });

  test('saveBearerToken(token, true, baseUrl) applies URL before testConnection', async () => {
    const server = await startOllamaMockServer();
    try {
      // Start with a WRONG base URL
      const client = new OllamaClient('http://127.0.0.1:1');
      const tokenManager = stubTokenManager();
      const handler = new SettingsHandler(
        client,
        tokenManager,
        stubDatabaseService(),
        emitter
      );

      // Pass correct baseUrl — should be applied before test
      await handler.saveBearerToken('test-token', true, server.baseUrl);

      // Should have sent bearerTokenSaved
      const saved = messages.find(m => m.type === 'bearerTokenSaved');
      assert.ok(saved, 'Should have sent bearerTokenSaved');
      assert.strictEqual(saved.hasToken, true);

      // Should have sent connectionTestResult with models
      const result = messages.find(m => m.type === 'connectionTestResult');
      assert.ok(result, 'Should have sent connectionTestResult');
      assert.strictEqual(result.success, true, 'Connection should succeed with correct URL');
      assert.ok(Array.isArray(result.models), 'Should include models');
    } finally {
      await server.close();
    }
  });

  test('saveBearerToken without testAfterSave does not call testConnection', async () => {
    const client = new OllamaClient('http://127.0.0.1:1');
    const handler = new SettingsHandler(
      client,
      stubTokenManager(),
      stubDatabaseService(),
      emitter
    );

    await handler.saveBearerToken('tok', false);

    assert.ok(messages.find(m => m.type === 'bearerTokenSaved'));
    assert.ok(!messages.find(m => m.type === 'connectionTestResult'),
      'Should NOT call testConnection when testAfterSave is false');
  });
});

// --- Stub helpers ---

function stubTokenManager(): any {
  return {
    hasToken: async () => false,
    getToken: async () => null,
    setToken: async (_t: string) => {},
    deleteToken: async () => {}
  };
}

function stubDatabaseService(): any {
  return {
    upsertModels: async () => {},
    getCachedModels: async () => [],
  };
}
