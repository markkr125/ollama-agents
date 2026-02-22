import * as assert from 'assert';

/**
 * Tests for sub-agent isolation — the filtered emitter mechanism that prevents
 * sub-agent text streaming, thinking, and final message events from leaking
 * into the parent timeline.
 *
 * This is the core safety contract: when `isSubagent=true`, only tool UI
 * events (progress groups, tool actions, errors, warnings) pass through.
 * Text-level events (streamChunk, thinkingBlock, finalMessage, etc.) are
 * suppressed so the parent's timeline is unaffected.
 *
 * We replicate the filtered emitter function from agentExploreExecutor.ts
 * to test it in isolation without needing VS Code, OllamaClient, etc.
 */

// ── Replicate the filtered emitter logic from agentExploreExecutor.ts ──
// This mirrors the `emit` function created when `isSubagent=true`.
const TOOL_UI_TYPES = new Set([
  'startProgressGroup', 'showToolAction', 'finishProgressGroup',
  'showError', 'showWarningBanner',
]);

function createFilteredEmitter(subLabel: string): {
  emitted: any[];
  emit: (msg: any) => void;
} {
  const emitted: any[] = [];
  const emit = (msg: any) => {
    if (TOOL_UI_TYPES.has(msg.type)) {
      // Prefix progress group titles with sub-agent label for visual nesting
      if (msg.type === 'startProgressGroup' && msg.title) {
        msg = { ...msg, title: `${subLabel}: ${msg.title}` };
      }
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
    'startProgressGroup',
    'showToolAction',
    'finishProgressGroup',
    'showError',
    'showWarningBanner',
  ];

  for (const type of PASSTHROUGH_TYPES) {
    test(`passes through '${type}' in sub-agent mode`, () => {
      const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
      emit({ type, text: 'test', sessionId: 'session-1' });
      assert.strictEqual(emitted.length, 1, `'${type}' should pass through but was suppressed`);
      assert.strictEqual(emitted[0].type, type);
    });
  }

  // ── Progress group title prefixing ──────────────────────────────

  test('prefixes startProgressGroup title with sub-agent label', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'startProgressGroup', title: 'Reading files', groupId: 'g1' });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].title, '🤖 Sub-agent: Reading files');
    assert.strictEqual(emitted[0].groupId, 'g1', 'groupId should be preserved');
  });

  test('uses custom subagentTitle in prefix', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Exploring auth');
    emit({ type: 'startProgressGroup', title: 'Searching codebase', groupId: 'g2' });
    assert.strictEqual(emitted[0].title, '🤖 Exploring auth: Searching codebase');
  });

  test('does NOT prefix non-startProgressGroup tool UI types', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'showToolAction', text: 'Reading src/index.ts', icon: 'file' });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].text, 'Reading src/index.ts', 'showToolAction text should NOT be prefixed');
  });

  // ── Original message immutability ───────────────────────────────

  test('does NOT mutate the original startProgressGroup message', () => {
    const { emit } = createFilteredEmitter('🤖 Sub-agent');
    const original = { type: 'startProgressGroup', title: 'Reading files', groupId: 'g3' };
    emit(original);
    assert.strictEqual(original.title, 'Reading files', 'Original message should not be mutated');
  });

  // ── Mixed event sequences ───────────────────────────────────────

  test('filters correctly in a mixed event sequence', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');

    // Simulate a real sub-agent execution sequence
    emit({ type: 'streamChunk', content: 'Analyzing...' });           // suppressed
    emit({ type: 'thinkingBlock', content: 'Let me think...' });      // suppressed
    emit({ type: 'startProgressGroup', title: 'Reading', groupId: '1' }); // pass
    emit({ type: 'showToolAction', text: 'read_file', status: 'running' }); // pass
    emit({ type: 'showToolAction', text: 'read_file', status: 'success' }); // pass
    emit({ type: 'finishProgressGroup', groupId: '1' });              // pass
    emit({ type: 'collapseThinking' });                               // suppressed
    emit({ type: 'tokenUsage', tokens: 1000 });                      // suppressed
    emit({ type: 'finalMessage', content: 'Done.' });                 // suppressed
    emit({ type: 'showError', message: 'Tool failed' });              // pass

    assert.strictEqual(emitted.length, 5, 'Should emit exactly 5 tool UI events');
    assert.deepStrictEqual(
      emitted.map(e => e.type),
      ['startProgressGroup', 'showToolAction', 'showToolAction', 'finishProgressGroup', 'showError']
    );
  });

  // ── startProgressGroup without title ────────────────────────────

  test('startProgressGroup without title still passes through', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'startProgressGroup', groupId: 'g5' });
    assert.strictEqual(emitted.length, 1);
    // Title is falsy, so no prefixing occurs
    assert.strictEqual(emitted[0].title, undefined);
  });

  // ── Unknown event types are suppressed (not in TOOL_UI_TYPES) ──

  test('unknown event types are suppressed', () => {
    const { emitted, emit } = createFilteredEmitter('🤖 Sub-agent');
    emit({ type: 'someNewEventType', data: 'test' });
    assert.strictEqual(emitted.length, 0, 'Unknown types should be suppressed by the allowlist');
  });
});
