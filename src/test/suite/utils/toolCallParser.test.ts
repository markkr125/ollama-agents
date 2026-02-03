import * as assert from 'assert';
import {
    detectPartialToolCall,
    extractToolCalls,
    removeToolCalls
} from '../../../utils/toolCallParser';

suite('toolCallParser', () => {
  test('detectPartialToolCall() returns tool name for partial XML tool call', () => {
    const name = detectPartialToolCall('<tool_call>{"name":"read_file"');
    assert.strictEqual(name, 'read_file');
  });

  test('extractToolCalls() parses XML tool_call blocks', () => {
    const text = [
      'Hello',
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
      '<tool_call>{"name":"search_workspace","arguments":{"query":"x"}}</tool_call>'
    ].join('\n');

    const calls = extractToolCalls(text);
    assert.deepStrictEqual(calls, [
      { name: 'read_file', args: { path: 'a.ts' } },
      { name: 'search_workspace', args: { query: 'x' } }
    ]);
  });

  test('extractToolCalls() parses [TOOL_CALLS]/[ARGS] format (including smart quotes)', () => {
    const text = '[TOOL_CALLS] write_file [ARGS] {“path":"a.ts","content":"hi"}\n';
    const calls = extractToolCalls(text);
    assert.deepStrictEqual(calls, [{ name: 'write_file', args: { path: 'a.ts', content: 'hi' } }]);
  });

  test('extractToolCalls() ignores invalid JSON blocks', () => {
    const text = '<tool_call>{not json}</tool_call>\n[TOOL_CALLS] x [ARGS] {not json}\n';
    const calls = extractToolCalls(text);
    assert.deepStrictEqual(calls, []);
  });

  test('removeToolCalls() removes tool markup and task complete marker', () => {
    const text = [
      'Explain',
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
      '[TOOL_CALLS] write_file [ARGS] {"path":"a.ts","content":"hi"}',
      '[TASK_COMPLETE]'
    ].join('\n');

    const cleaned = removeToolCalls(text);
    assert.strictEqual(cleaned, 'Explain');
  });

  test('removeToolCalls() removes trailing partial <tool_call> block', () => {
    const text = 'Hello\n<tool_call>{"name":"read_file"';
    const cleaned = removeToolCalls(text);
    assert.strictEqual(cleaned, 'Hello');
  });
});
