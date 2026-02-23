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

  // Regression: verify that many small NDJSON chunks are all delivered individually
  // by the streaming pipeline. This tests the backend side of the streaming fix
  // (parseNDJSON + async generator). If chunks were silently merged or dropped,
  // the webview would receive fewer streamChunk messages than expected.
  test('chat() delivers all chunks from a multi-chunk stream without merging or dropping', async () => {
    const words = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog', '.'];
    const server = await startOllamaMockServer({ type: 'chatMultiChunk', chunks: words });
    try {
      const client = new OllamaClient(server.baseUrl);

      const received: string[] = [];
      for await (const chunk of client.chat({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }]
      })) {
        if (chunk.message?.content) {
          received.push(chunk.message.content);
        }
        if (chunk.done) {
          break;
        }
      }

      // Every chunk should arrive as a separate yield from the async generator
      assert.strictEqual(received.length, words.length);
      for (let i = 0; i < words.length; i++) {
        assert.strictEqual(received[i], words[i], `chunk ${i} mismatch`);
      }
      assert.strictEqual(received.join(''), 'The quick brown fox jumps over the lazy dog.');
    } finally {
      await server.close();
    }
  });

  test('chat() with AbortSignal terminates instantly on a hanging stream', async () => {
    // chatHang sends one chunk then holds the connection open forever.
    // Without abort, this test would hang indefinitely.
    const server = await startOllamaMockServer({ type: 'chatHang' });
    try {
      const client = new OllamaClient(server.baseUrl);
      const controller = new AbortController();

      const received: string[] = [];
      const start = Date.now();

      try {
        for await (const chunk of client.chat(
          { model: 'test-model', messages: [{ role: 'user', content: 'test' }] },
          controller.signal
        )) {
          if (chunk.message?.content) {
            received.push(chunk.message.content);
          }
          // After the first chunk, abort immediately
          controller.abort();
        }
      } catch (err: any) {
        // AbortError is expected — that's the whole point of this test
        assert.strictEqual(err.name, 'AbortError', `Expected AbortError, got ${err.name}: ${err.message}`);
      }

      const elapsed = Date.now() - start;
      // Should exit almost instantly after abort (well under 2s)
      assert.ok(elapsed < 2000, `Abort took ${elapsed}ms — stream was not terminated promptly`);
      // Should have received the one chunk that was sent before the hang
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], 'partial');
    } finally {
      await server.close();
    }
  });
});
