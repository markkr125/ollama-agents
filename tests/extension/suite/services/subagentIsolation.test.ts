import * as assert from 'assert';

/**
 * Tests for sub-agent isolation — the filtered emitter mechanism that prevents
 * sub-agent text streaming, thinking, and final message events from leaking
 * into the parent timeline.
 *
 * This is the core safety contract: when `isSubagent=true`, only tool UI
 * events (tool actions, errors, warnings, subagentThinking) pass through.
 * Text-level events (streamChunk, thinkingBlock, finalMessage, etc.) are
 * suppressed so the parent's timeline is unaffected.
 *
 * Per-iteration startProgressGroup/finishProgressGroup are also suppressed
 * because the sub-agent uses a single wrapper progress group (emitted before
 * and after the loop via this.emitter.postMessage, NOT via the filtered emit).
 *
 * We replicate the filtered emitter function from agentExploreExecutor.ts
 * to test it in isolation without needing VS Code, OllamaClient, etc.
 */

// ── Replicate the filtered emitter logic from agentExploreExecutor.ts ──
// This mirrors the `emit` function created when `isSubagent=true`.
const TOOL_UI_TYPES = new Set([
  'showToolAction',
  'showError', 'showWarningBanner', 'subagentThinking',
]);

function createFilteredEmitter(_subLabel: string): {
  emitted: any[];
  emit: (msg: any) => void;
} {
  const emitted: any[] = [];
  const emit = (msg: any) => {
    if (TOOL_UI_TYPES.has(msg.type)) {
      emitted.push(msg);
    }
    // All other types are suppressed (not pushed)
  };
  return { emitted, emit };
}

suite('Sub-agent isolation — filtered emitter', () => {

  // ── Suppressed event types ──────────────────────────────────────

  const SUPPRESSED_TYPES = [
    'finalMessage',
    'streamChunk',
    'thinkingBlock',
    'collapseThinking',
    'tokenUsage',
    'iterationBoundary',
    'hideThinking',
    'startProgressGroup',
    'finishProgressGroup',
  ];

  for (const type of SUPPRESSED_TYPES) {
    test(`suppresses '${type}' in sub-agent mode`, () => {
      const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
      emit({ type, content: 'test data', sessionId: 'session-1' });
      assert.strictEqual(emitted.length, 0, `'${type}' should be suppressed but was emitted`);
    });
  }

  // ── Pass-through event types ────────────────────────────────────

  const PASSTHROUGH_TYPES = [
    'showToolAction',
    'showError',
    'showWarningBanner',
    'subagentThinking',
  ];

  for (const type of PASSTHROUGH_TYPES) {
    test(`passes through '${type}' in sub-agent mode`, () => {
      const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
      emit({ type, text: 'test', sessionId: 'session-1' });
      assert.strictEqual(emitted.length, 1, `'${type}' should pass through but was suppressed`);
      assert.strictEqual(emitted[0].type, type);
    });
  }

  // ── Per-iteration progress group suppression ─────────────────────

  test('suppresses startProgressGroup from internal tool batches', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'startProgressGroup', title: 'Reading files', groupId: 'g1' });
    assert.strictEqual(emitted.length, 0, 'Internal startProgressGroup should be suppressed');
  });

  test('suppresses finishProgressGroup from internal tool batches', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'finishProgressGroup', groupId: 'g1' });
    assert.strictEqual(emitted.length, 0, 'Internal finishProgressGroup should be suppressed');
  });

  test('subagentThinking passes through to parent emitter', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'subagentThinking', content: 'I am analyzing...', durationSeconds: 5 });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].content, 'I am analyzing...');
    assert.strictEqual(emitted[0].durationSeconds, 5);
  });

  // ── showToolAction passes through unchanged ─────────────────────

  test('does NOT modify showToolAction text', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'showToolAction', text: 'Reading src/index.ts', icon: 'file' });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].text, 'Reading src/index.ts', 'showToolAction text should pass through unchanged');
  });

  // ── Mixed event sequences ───────────────────────────────────────

  test('filters correctly in a mixed event sequence', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');

    // Simulate a real sub-agent execution sequence
    // NOTE: startProgressGroup/finishProgressGroup are now suppressed because
    // the sub-agent uses a single wrapper group emitted via this.emitter.postMessage
    // (not via the filtered emit function).
    emit({ type: 'streamChunk', content: 'Analyzing...' });           // suppressed
    emit({ type: 'thinkingBlock', content: 'Let me think...' });      // suppressed
    emit({ type: 'startProgressGroup', title: 'Reading', groupId: '1' }); // suppressed (internal)
    emit({ type: 'showToolAction', text: 'read_file', status: 'running' }); // pass
    emit({ type: 'showToolAction', text: 'read_file', status: 'success' }); // pass
    emit({ type: 'subagentThinking', content: 'Reasoning...', durationSeconds: 3 }); // pass
    emit({ type: 'finishProgressGroup', groupId: '1' });              // suppressed (internal)
    emit({ type: 'collapseThinking' });                               // suppressed
    emit({ type: 'tokenUsage', tokens: 1000 });                      // suppressed
    emit({ type: 'finalMessage', content: 'Done.' });                 // suppressed
    emit({ type: 'showError', message: 'Tool failed' });              // pass

    assert.strictEqual(emitted.length, 4, 'Should emit exactly 4 tool UI events');
    assert.deepStrictEqual(
      emitted.map(e => e.type),
      ['showToolAction', 'showToolAction', 'subagentThinking', 'showError']
    );
  });

  // ── All internal progress group events are suppressed ────────────

  test('startProgressGroup without title is also suppressed', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'startProgressGroup', groupId: 'g5' });
    assert.strictEqual(emitted.length, 0, 'Internal startProgressGroup should always be suppressed');
  });

  // ── Unknown event types are suppressed (not in TOOL_UI_TYPES) ──

  test('unknown event types are suppressed', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'someNewEventType', data: 'test' });
    assert.strictEqual(emitted.length, 0, 'Unknown types should be suppressed by the allowlist');
  });
});
