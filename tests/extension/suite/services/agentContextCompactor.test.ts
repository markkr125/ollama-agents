import * as assert from 'assert';
import { AgentContextCompactor } from '../../../../src/services/agent/agentContextCompactor';

/**
 * Tests for AgentContextCompactor — conversation summarization when
 * approaching context window limit.
 */

// ─── Stub helpers ────────────────────────────────────────────────────

function createStreamingMockClient(summaryResponse = 'Summary of work done.'): any {
  return {
    chat: (): AsyncGenerator => {
      const chunks = [{ message: { content: summaryResponse } }];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    }
  };
}

function createFailingClient(): any {
  return {
    chat: (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('LLM unavailable'))
      })
    })
  };
}

/** Build a messages array of a given approximate token count. */
function buildMessages(messageCount: number, wordsPerMessage = 50): any[] {
  const messages: any[] = [
    { role: 'system', content: 'You are a helpful assistant. '.repeat(5) },
  ];
  for (let i = 1; i <= messageCount; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant';
    messages.push({ role, content: `Message ${i} ` + 'word '.repeat(wordsPerMessage) });
  }
  return messages;
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('AgentContextCompactor', () => {
  test('returns false when tokens below threshold (70%)', async () => {
    const compactor = new AgentContextCompactor(createStreamingMockClient());
    const messages = buildMessages(4, 10); // ~5 messages, ~13 words each ≈ ~85 tokens
    const contextWindow = 10000; // 70% = 7000 — well above

    const result = await compactor.compactIfNeeded(messages, contextWindow, 'test-model');
    assert.strictEqual(result, false, 'Should not compact when well under threshold');
  });

  test('returns false with <= 4 total messages', async () => {
    const compactor = new AgentContextCompactor(createStreamingMockClient());
    const messages = [
      { role: 'system', content: 'System prompt ' + 'x '.repeat(5000) },
      { role: 'user', content: 'Hello ' + 'x '.repeat(5000) },
      { role: 'assistant', content: 'Response ' + 'x '.repeat(5000) },
    ];
    // 3 messages — even if tokens are high, shouldn't compact
    const result = await compactor.compactIfNeeded(messages, 100, 'test-model');
    assert.strictEqual(result, false, 'Should not compact with <= 4 messages');
  });

  test('returns false when only 1 message between system and preserved tail', async () => {
    const compactor = new AgentContextCompactor(createStreamingMockClient());
    // 5 messages: system + 4 others. Preserve 4 = tail starts at 1. toSummarize = slice(1,1) = empty
    const messages = buildMessages(4, 500); // system + 4 messages with lots of words
    // But preserved count = min(6, 4) = 4, preserveStart = 5 - 4 = 1
    // toSummarize = slice(1, 1) = empty, so returns false
    const result = await compactor.compactIfNeeded(messages, 100, 'test-model');
    assert.strictEqual(result, false, 'Should not compact when no summarizable messages');
  });

  test('compacts when above threshold with many messages', async () => {
    const compactor = new AgentContextCompactor(createStreamingMockClient('Compacted summary'));

    // Create messages that will be above 70% of a small context window
    const messages = buildMessages(12, 100); // system + 12 messages, ~100 words each => ~1560 tokens
    const originalLength = messages.length;
    const contextWindow = 1000; // 70% = 700, well below estimated tokens

    const result = await compactor.compactIfNeeded(messages, contextWindow, 'test-model');
    assert.strictEqual(result, true, 'Should compact');
    assert.ok(messages.length < originalLength, 'Message array should be shorter after compaction');

    // System prompt should still be first
    assert.strictEqual(messages[0].role, 'system', 'First message should be system');

    // Summary message should be second
    assert.ok(messages[1].content.includes('<context_summary>'), 'Second message should be context summary');
    assert.ok(messages[1].content.includes('Compacted summary'), 'Summary should contain LLM response');
  });

  test('preserves last 6 messages (3 pairs) as tail', async () => {
    const compactor = new AgentContextCompactor(createStreamingMockClient('Summary'));

    const messages = buildMessages(14, 100); // system + 14 = 15 total
    const contextWindow = 500; // force compaction

    // Tail should be the last 6 messages
    const tailMessages = messages.slice(-6).map(m => m.content);

    const result = await compactor.compactIfNeeded(messages, contextWindow, 'test-model');
    assert.strictEqual(result, true);

    // After compaction: [system, summary, ...last6] = 8 messages
    assert.strictEqual(messages.length, 8, `Expected 8 messages after compaction, got ${messages.length}`);

    // Verify tail preservation
    const preservedTail = messages.slice(-6).map(m => m.content);
    assert.deepStrictEqual(preservedTail, tailMessages, 'Last 6 messages should be preserved');
  });

  test('returns false when LLM summary generation fails', async () => {
    const compactor = new AgentContextCompactor(createFailingClient());

    const messages = buildMessages(14, 100);
    const originalLength = messages.length;
    const contextWindow = 500;

    const result = await compactor.compactIfNeeded(messages, contextWindow, 'test-model');
    assert.strictEqual(result, false, 'Should return false on LLM failure');
    assert.strictEqual(messages.length, originalLength, 'Messages should not be modified on failure');
  });

  test('summary prompt includes expected sections', async () => {
    let capturedMessages: any[] = [];
    const captureClient = {
      chat: (request: any): AsyncGenerator => {
        capturedMessages = request.messages;
        return (async function* () {
          yield { message: { content: 'Summary' } };
        })();
      }
    };

    const compactor = new AgentContextCompactor(captureClient as any);
    const messages = buildMessages(14, 100);
    await compactor.compactIfNeeded(messages, 500, 'test-model');

    assert.ok(capturedMessages.length > 0, 'Should have called client.chat');
    const userMsg = capturedMessages.find((m: any) => m.role === 'user');
    assert.ok(userMsg, 'Should have user message in summary request');
    assert.ok(userMsg.content.includes('TASK OVERVIEW'), 'Summary prompt should mention TASK OVERVIEW');
    assert.ok(userMsg.content.includes('CURRENT STATE'), 'Summary prompt should mention CURRENT STATE');
    assert.ok(userMsg.content.includes('KEY CODE CONTEXT'), 'Summary prompt should mention KEY CODE CONTEXT');
  });
});
