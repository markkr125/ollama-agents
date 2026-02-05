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

  // --- New comprehensive tests for balanced JSON extraction and LLM quirks ---

  suite('Balanced JSON Extraction (nested objects)', () => {
    test('extracts tool call with nested JSON in content field', () => {
      const response = `<tool_call>{"name": "write_file", "arguments": {"path": "test.json", "content": "{\\"name\\": \\"demo\\"}"}}</tool_call>`;
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'write_file');
      assert.strictEqual(result[0].args.path, 'test.json');
      assert.strictEqual(result[0].args.content, '{"name": "demo"}');
    });

    test('extracts tool call with deeply nested JSON (package.json with scripts)', () => {
      const content = '{"name": "project", "scripts": {"test": "echo test", "build": "tsc"}}';
      const response = `<tool_call>{"name": "write_file", "arguments": {"path": "package.json", "content": ${JSON.stringify(content)}}}</tool_call>`;
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'write_file');
      assert.strictEqual(result[0].args.content, content);
    });

    test('handles content with multiple levels of nesting', () => {
      const content = '{"a": {"b": {"c": {"d": "value"}}}}';
      const response = `<tool_call>{"name": "write_file", "arguments": {"path": "deep.json", "content": ${JSON.stringify(content)}}}</tool_call>`;
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.content, content);
    });
  });

  suite('Alternative argument field names', () => {
    test('accepts "args" instead of "arguments"', () => {
      const response = '<tool_call>{"name": "read_file", "args": {"path": "file.ts"}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.path, 'file.ts');
    });

    test('accepts "params" instead of "arguments"', () => {
      const response = '<tool_call>{"name": "read_file", "params": {"path": "file.ts"}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.path, 'file.ts');
    });

    test('accepts "parameters" instead of "arguments"', () => {
      const response = '<tool_call>{"name": "read_file", "parameters": {"path": "file.ts"}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.path, 'file.ts');
    });
  });

  suite('Top-level arguments (no nested object)', () => {
    test('extracts args from top level when no arguments field', () => {
      const response = '<tool_call>{"name": "read_file", "path": "file.ts"}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'read_file');
      assert.strictEqual(result[0].args.path, 'file.ts');
    });

    test('extracts multiple top-level args', () => {
      const response = '<tool_call>{"name": "write_file", "path": "file.ts", "content": "hello"}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.path, 'file.ts');
      assert.strictEqual(result[0].args.content, 'hello');
    });
  });

  suite('Alternative tool name fields', () => {
    test('accepts "tool" instead of "name"', () => {
      const response = '<tool_call>{"tool": "read_file", "arguments": {"path": "file.ts"}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'read_file');
    });

    test('accepts "function" instead of "name"', () => {
      const response = '<tool_call>{"function": "read_file", "arguments": {"path": "file.ts"}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'read_file');
    });
  });

  suite('Incomplete tool calls (LLM cutoff)', () => {
    test('handles incomplete tool call (no closing tag)', () => {
      const response = '<tool_call>{"name": "read_file", "arguments": {"path": "file.ts"}}';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'read_file');
      assert.strictEqual(result[0].args.path, 'file.ts');
    });

    test('handles incomplete JSON with one missing closing brace', () => {
      const response = '<tool_call>{"name": "read_file", "arguments": {"path": "file.ts"}';
      const result = extractToolCalls(response);
      
      // Parser attempts to repair by adding closing braces
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'read_file');
    });

    test('handles incomplete JSON with multiple missing closing braces', () => {
      const response = '<tool_call>{"name": "write_file", "arguments": {"path": "file.ts", "content": "test"';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'write_file');
    });
  });

  suite('Edge cases', () => {
    test('ignores tool call without name field', () => {
      const response = '<tool_call>{"arguments": {"path": "file.ts"}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 0);
    });

    test('handles content with escaped quotes', () => {
      const content = 'const x = "hello \\"world\\""';
      const response = `<tool_call>{"name": "write_file", "arguments": {"path": "test.ts", "content": ${JSON.stringify(content)}}}</tool_call>`;
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.content, content);
    });

    test('handles content with newlines', () => {
      const content = 'line1\nline2\nline3';
      const response = `<tool_call>{"name": "write_file", "arguments": {"path": "test.txt", "content": ${JSON.stringify(content)}}}</tool_call>`;
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].args.content, content);
    });

    test('extracts from response with surrounding text and explanation', () => {
      const response = `
        I'll read the package.json file first to see the current project name.
        <tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>
        This will show us the current configuration.
      `;
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'read_file');
      assert.strictEqual(result[0].args.path, 'package.json');
    });

    test('handles empty arguments object', () => {
      const response = '<tool_call>{"name": "list_files", "arguments": {}}</tool_call>';
      const result = extractToolCalls(response);
      
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'list_files');
      assert.deepStrictEqual(result[0].args, {});
    });
  });
});
