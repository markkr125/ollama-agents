import * as assert from 'assert';
import { OllamaClient } from '../../../../src/services/model/ollamaClient';
import { startOllamaMockServer } from '../../mocks/ollamaMockServer';

suite('OllamaClient (mocked API)', () => {
  test('listModels() returns mock model', async () => {
    const server = await startOllamaMockServer();
    try {
      const client = new OllamaClient(server.baseUrl);
      const models = await client.listModels();

      assert.ok(Array.isArray(models));
      assert.strictEqual(models.length, 1);
      assert.strictEqual(models[0].name, 'test-model');
    } finally {
      await server.close();
    }
  });

  test('testConnection() returns true against mock server', async () => {
    const server = await startOllamaMockServer();
    try {
      const client = new OllamaClient(server.baseUrl);
      const ok = await client.testConnection();
      assert.strictEqual(ok, true);
    } finally {
      await server.close();
    }
  });

  test('chat() streams assistant message chunks', async () => {
    const server = await startOllamaMockServer({ type: 'chatEcho' });
    try {
      const client = new OllamaClient(server.baseUrl);

      const chunks: string[] = [];
      for await (const chunk of client.chat({
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }]
      })) {
        if (chunk.message?.content) {
          chunks.push(chunk.message.content);
        }
        if (chunk.done) {
          break;
        }
      }

      assert.strictEqual(chunks.join(''), 'echo:ping');
    } finally {
      await server.close();
    }
  });

  test('generate() streams response chunks', async () => {
    const server = await startOllamaMockServer();
    try {
      const client = new OllamaClient(server.baseUrl);

      const chunks: string[] = [];
      for await (const chunk of client.generate({
        model: 'test-model',
        prompt: 'abcdef'
      })) {
        if (chunk.response) {
          chunks.push(chunk.response);
        }
        if (chunk.done) {
          break;
        }
      }

      assert.strictEqual(chunks.join(''), 'abcdef');
    } finally {
      await server.close();
    }
  });
});
