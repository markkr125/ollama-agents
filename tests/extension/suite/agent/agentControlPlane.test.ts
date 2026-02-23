import * as assert from 'assert';
import {
    buildContinuationControlMessage,
    buildControlPacketMessage,
    buildLoopContinuationMessage,
    buildToolCallSummary,
    checkNoToolCompletion,
    computeDynamicNumCtx,
    formatNativeToolResults,
    formatTextToolResults,
    isCompletionSignaled,
    parseControlState,
    resolveControlState,
    stripControlPackets,
} from '../../../../src/agent/execution/streaming/agentControlPlane';

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

// ── computeDynamicNumCtx ──────────────────────────────────────────

suite('computeDynamicNumCtx — dynamic num_ctx sizing', () => {
  test('small payload returns MIN_NUM_CTX (4096)', () => {
    // 100 tokens payload + 2048 predict + 512 buffer = 2660 → aligned to 4096 → clamped to MIN
    const result = computeDynamicNumCtx(100, 2048, 131072);
    assert.strictEqual(result, 4096);
  });

  test('medium payload aligns up to nearest 2048', () => {
    // 3000 tokens + 4096 predict + 512 buffer = 7608 → ceil to 8192
    const result = computeDynamicNumCtx(3000, 4096, 131072);
    assert.strictEqual(result, 8192);
  });

  test('large payload capped at model context window', () => {
    // 50000 tokens + 8192 predict + 512 buffer = 58704 → aligned to 59392
    // But model only has 32768 → capped
    const result = computeDynamicNumCtx(50000, 8192, 32768);
    assert.strictEqual(result, 32768);
  });

  test('exact alignment boundary stays at that boundary', () => {
    // 1024 + 512 + 512 = 2048 → exactly 2048 → max(2048, 4096) = 4096
    const result = computeDynamicNumCtx(1024, 512, 131072);
    assert.strictEqual(result, 4096);
  });

  test('zero payload still returns MIN_NUM_CTX', () => {
    const result = computeDynamicNumCtx(0, 0, 131072);
    assert.strictEqual(result, 4096);
  });

  test('payload close to model max returns model max', () => {
    // 60000 + 8192 + 512 = 68704 → aligned to 69632 → but model is 65536 → capped
    const result = computeDynamicNumCtx(60000, 8192, 65536);
    assert.strictEqual(result, 65536);
  });

  test('realistic first iteration: ~6K tokens payload', () => {
    // Typical first turn: ~1500 system + ~500 user + ~2600 tools ≈ 4600 tokens
    // 4600 + 8192 predict + 512 buffer = 13304 → aligned to 14336
    const result = computeDynamicNumCtx(4600, 8192, 393216);
    assert.strictEqual(result, 14336);
  });

  test('small model context is respected', () => {
    const result = computeDynamicNumCtx(1000, 2048, 2048);
    assert.strictEqual(result, 2048);
  });
});

suite('buildToolCallSummary', () => {
  test('returns undefined for empty array', () => {
    assert.strictEqual(buildToolCallSummary([]), undefined);
  });

  test('returns undefined for undefined input', () => {
    assert.strictEqual(buildToolCallSummary(undefined as any), undefined);
  });

  test('summarizes read_file', () => {
    const result = buildToolCallSummary([{ name: 'read_file', args: { path: 'src/index.ts' } }]);
    assert.ok(result);
    assert.ok(result!.includes('read'), `Expected 'read' in: ${result}`);
    assert.ok(result!.includes('index.ts'), `Expected 'index.ts' in: ${result}`);
  });

  test('summarizes write_file', () => {
    const result = buildToolCallSummary([{ name: 'write_file', args: { path: 'src/app.ts' } }]);
    assert.ok(result);
    assert.ok(result!.includes('wrote'), `Expected 'wrote' in: ${result}`);
  });

  test('summarizes search_workspace', () => {
    const result = buildToolCallSummary([{ name: 'search_workspace', args: { query: 'handleClick' } }]);
    assert.ok(result);
    assert.ok(result!.includes('searched'), `Expected 'searched' in: ${result}`);
    assert.ok(result!.includes('handleClick'), `Expected query in: ${result}`);
  });

  test('summarizes run_terminal_command', () => {
    const result = buildToolCallSummary([{ name: 'run_terminal_command', args: { command: 'npm test' } }]);
    assert.ok(result);
    assert.ok(result!.includes('ran'), `Expected 'ran' in: ${result}`);
    assert.ok(result!.includes('npm test'), `Expected command in: ${result}`);
  });

  test('summarizes run_subagent', () => {
    const result = buildToolCallSummary([{ name: 'run_subagent', args: { task: 'explore auth' } }]);
    assert.ok(result);
    assert.ok(result!.includes('delegated'), `Expected 'delegated' in: ${result}`);
  });

  test('chains multiple tool calls with "then"', () => {
    const result = buildToolCallSummary([
      { name: 'search_workspace', args: { query: 'foo' } },
      { name: 'read_file', args: { path: 'src/foo.ts' } },
    ]);
    assert.ok(result);
    assert.ok(result!.includes(', then '), `Expected 'then' chaining in: ${result}`);
    assert.ok(result!.startsWith('I '), `Should start with 'I': ${result}`);
    assert.ok(result!.endsWith('.'), `Should end with period: ${result}`);
  });

  test('summarizes LSP tools (find_definition, find_references, etc.)', () => {
    const result = buildToolCallSummary([
      { name: 'find_definition', args: { symbol: 'handleClick' } },
      { name: 'find_references', args: { symbol: 'handleClick' } },
      { name: 'get_call_hierarchy', args: { symbol: 'handleClick' } },
    ]);
    assert.ok(result);
    assert.ok(result!.includes('definition'), `Expected 'definition' in: ${result}`);
    assert.ok(result!.includes('references'), `Expected 'references' in: ${result}`);
    assert.ok(result!.includes('call hierarchy'), `Expected 'call hierarchy' in: ${result}`);
  });

  test('handles unknown tool names gracefully', () => {
    const result = buildToolCallSummary([{ name: 'custom_tool', args: { x: 1 } }]);
    assert.ok(result);
    assert.ok(result!.includes('used custom_tool'), `Expected fallback 'used custom_tool' in: ${result}`);
  });

  test('summarizes get_diagnostics', () => {
    const result = buildToolCallSummary([{ name: 'get_diagnostics', args: { path: 'src/app.ts' } }]);
    assert.ok(result);
    assert.ok(result!.includes('diagnostics'), `Expected 'diagnostics' in: ${result}`);
  });

  test('summarizes list_files', () => {
    const result = buildToolCallSummary([{ name: 'list_files', args: { path: 'src' } }]);
    assert.ok(result);
    assert.ok(result!.includes('listed'), `Expected 'listed' in: ${result}`);
  });
});
