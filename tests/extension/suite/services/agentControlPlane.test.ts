import * as assert from 'assert';
import {
    buildContinuationControlMessage,
    buildControlPacketMessage,
    buildLoopContinuationMessage,
    checkNoToolCompletion,
    formatNativeToolResults,
    formatTextToolResults,
    isCompletionSignaled,
    parseControlState,
    resolveControlState,
    stripControlPackets,
} from '../../../../src/services/agent/agentControlPlane';

suite('agentControlPlane', () => {
  test('buildControlPacketMessage emits control envelope', () => {
    const msg = buildControlPacketMessage({
      state: 'need_tools',
      iteration: 2,
      maxIterations: 25,
      remainingIterations: 23,
    }, 'minimal');

    assert.ok(msg.startsWith('<agent_control>'));
    assert.ok(msg.endsWith('</agent_control>'));
    assert.strictEqual(parseControlState(msg), 'need_tools');
  });

  test('parseControlState reads complete state from mixed text', () => {
    const msg = 'done <agent_control>{"state":"complete","iteration":3,"maxIterations":25,"remainingIterations":22}</agent_control>';
    assert.strictEqual(parseControlState(msg), 'complete');
  });

  test('stripControlPackets removes all control payloads', () => {
    const input = 'hello <agent_control>{"state":"need_tools"}</agent_control> world';
    assert.strictEqual(stripControlPackets(input), 'hello  world'.trim());
  });

  test('buildContinuationControlMessage increments iteration and computes remaining', () => {
    const msg = buildContinuationControlMessage({
      state: 'need_tools',
      iteration: 3,
      maxIterations: 25,
      strategy: 'full',
      note: 'Continue with tools',
    });

    assert.ok(msg.includes('"iteration":4'));
    assert.ok(msg.includes('"remainingIterations":21'));
    assert.strictEqual(parseControlState(msg), 'need_tools');
  });

  test('isCompletionSignaled supports control packet and legacy markers', () => {
    assert.strictEqual(
      isCompletionSignaled('<agent_control>{"state":"complete","iteration":1,"maxIterations":25,"remainingIterations":24}</agent_control>', ''),
      true
    );
    assert.strictEqual(isCompletionSignaled('Done. [TASK_COMPLETE]', ''), true);
    assert.strictEqual(isCompletionSignaled('Task is complete.', ''), true);
    assert.strictEqual(isCompletionSignaled('Keep going', ''), false);
  });

  test('buildLoopContinuationMessage normalizes files and uses default note', () => {
    const msg = buildLoopContinuationMessage(
      {
        iteration: 4,
        maxIterations: 25,
        strategy: 'full',
        filesChanged: ['a.ts', 'a.ts', 123 as any, 'b.ts'],
        defaultNote: 'memory summary',
      },
      {
        state: 'need_tools',
      }
    );

    assert.ok(msg.includes('"iteration":5'));
    assert.ok(msg.includes('"remainingIterations":20'));
    assert.ok(msg.includes('"filesChanged":["a.ts","b.ts"]'));
    assert.ok(msg.includes('"note":"memory summary"'));
  });

  test('tool result formatters produce deterministic blocks', () => {
    assert.strictEqual(
      formatNativeToolResults([
        { tool_name: 'read_file', content: 'ok' },
        { tool_name: 'search_workspace', content: '2 matches' },
      ]),
      '[read_file result]\nok\n\n[search_workspace result]\n2 matches'
    );

    assert.strictEqual(
      formatTextToolResults(['a', 'b', 'c']),
      'a\n\nb\n\nc'
    );
  });

  test('resolveControlState maps events via transition table', () => {
    assert.strictEqual(resolveControlState('no_tools'), 'need_tools');
    assert.strictEqual(resolveControlState('tool_results'), 'need_tools');
    assert.strictEqual(resolveControlState('diagnostics_errors'), 'need_fixes');
    assert.strictEqual(resolveControlState('need_summary'), 'need_summary');
  });

  test('buildLoopContinuationMessage derives state from event', () => {
    const msg = buildLoopContinuationMessage(
      {
        iteration: 1,
        maxIterations: 10,
        strategy: 'minimal',
      },
      {
        event: 'diagnostics_errors',
        note: 'Fix diagnostics',
      }
    );

    assert.strictEqual(parseControlState(msg), 'need_fixes');
    assert.ok(msg.includes('Fix diagnostics'));
  });

  test('buildLoopContinuationMessage appends directive without task reminder', () => {
    const msg = buildLoopContinuationMessage(
      { iteration: 1, maxIterations: 10, strategy: 'minimal', task: 'Refactor the parser to support async operations' },
      { event: 'tool_results' }
    );
    assert.ok(msg.includes('[TASK_COMPLETE]'), 'Should mention completion signal');
    // Task reminder was removed — the full task is already in messages[1].
    // Adding truncated previews caused models to fixate on the incomplete
    // snippet instead of reading the original user message.
    assert.ok(!msg.includes('Task:'), 'Should NOT include task reminder — full task is in messages[1]');
    // Directive must come AFTER the control packet (highest recency)
    const packetEnd = msg.indexOf('</agent_control>');
    const directiveStart = msg.indexOf('Proceed');
    assert.ok(directiveStart > packetEnd, 'Directive must come after control packet');
  });
});

// ── checkNoToolCompletion ─────────────────────────────────────────

suite('checkNoToolCompletion — smart completion detection', () => {
  // --- break_implicit: truly empty + files written → done ---

  test('empty response + empty thinking + files written → break_implicit', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: '', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 1 }),
      'break_implicit'
    );
  });

  test('whitespace-only response + files written → break_implicit', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: '   \n  ', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 1 }),
      'break_implicit'
    );
  });

  test('empty response + no thinking + files written (first no-tool iteration) → break_implicit', () => {
    // Even on the first no-tool iteration, truly empty + files written = done
    assert.strictEqual(
      checkNoToolCompletion({ response: '', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 1 }),
      'break_implicit'
    );
  });

  // --- break_implicit does NOT fire without hasWrittenFiles ---

  test('empty response + no files written → continue (not break)', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: '', thinkingContent: '', hasWrittenFiles: false, consecutiveNoToolIterations: 1 }),
      'continue'
    );
  });

  // --- break_implicit does NOT fire when response has text ---

  test('text response + files written → continue (model may be mid-task)', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: 'Now I will create the test file...', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 1 }),
      'continue'
    );
  });

  // --- break_implicit does NOT fire when thinking content present ---

  test('empty response but has thinking + files written → continue', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: '', thinkingContent: 'Let me think about this...', hasWrittenFiles: true, consecutiveNoToolIterations: 1 }),
      'continue'
    );
  });

  // --- break_consecutive: 2+ no-tool iterations → done regardless ---

  test('text response + 2 consecutive no-tool iterations → break_consecutive', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: 'Some text', thinkingContent: '', hasWrittenFiles: false, consecutiveNoToolIterations: 2 }),
      'break_consecutive'
    );
  });

  test('text response + 3 consecutive no-tool iterations → break_consecutive', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: 'More text', thinkingContent: '', hasWrittenFiles: false, consecutiveNoToolIterations: 3 }),
      'break_consecutive'
    );
  });

  test('thinking only + 2 consecutive no-tool iterations + no files → break_consecutive', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: '', thinkingContent: 'Thinking...', hasWrittenFiles: false, consecutiveNoToolIterations: 2 }),
      'break_consecutive'
    );
  });

  // --- continue: model gets one more chance ---

  test('text response + 1 no-tool iteration + no files → continue', () => {
    assert.strictEqual(
      checkNoToolCompletion({ response: 'I analyzed the code.', thinkingContent: '', hasWrittenFiles: false, consecutiveNoToolIterations: 1 }),
      'continue'
    );
  });

  test('text response + 1 no-tool iteration + files written → continue (write→text→write pattern)', () => {
    // This is the critical case: model wrote files, then gives a text response
    // like "Now I'll create the test file..." — it should NOT break yet.
    assert.strictEqual(
      checkNoToolCompletion({ response: 'Next I will update the imports.', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 1 }),
      'continue'
    );
  });

  // --- Priority: break_implicit wins over continue at iteration 1 ---

  test('break_implicit takes priority over counter being only 1', () => {
    // Truly empty + files written should break even at consecutiveNoToolIterations=1
    const result = checkNoToolCompletion({ response: '', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 1 });
    assert.strictEqual(result, 'break_implicit');
  });

  // --- Priority: break_implicit wins over break_consecutive ---

  test('break_implicit takes priority when both conditions met', () => {
    // At iteration 2+, both conditions are true — break_implicit should win (checked first)
    const result = checkNoToolCompletion({ response: '', thinkingContent: '', hasWrittenFiles: true, consecutiveNoToolIterations: 2 });
    assert.strictEqual(result, 'break_implicit');
  });
});
