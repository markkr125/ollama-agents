import * as assert from 'assert';
import { AgentSummaryBuilder } from '../../../../src/agent/execution/toolExecution/agentSummaryBuilder';

/**
 * Tests for AgentSummaryBuilder — generateStatusLine static method
 * and summary finalization logic.
 */

suite('AgentSummaryBuilder.generateStatusLine', () => {
  test('returns "Working..." for empty toolCalls', () => {
    assert.strictEqual(AgentSummaryBuilder.generateStatusLine([]), 'Working...');
  });

  test('returns "Working..." for null/undefined toolCalls', () => {
    assert.strictEqual(AgentSummaryBuilder.generateStatusLine(null as any), 'Working...');
    assert.strictEqual(AgentSummaryBuilder.generateStatusLine(undefined as any), 'Working...');
  });

  test('read_file returns "Reading {fileName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'read_file', input: { path: 'src/main.ts' } }
    ]);
    assert.strictEqual(result, 'Reading main.ts');
  });

  test('read_file with no path returns "Reading file"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'read_file', input: {} }
    ]);
    assert.strictEqual(result, 'Reading file');
  });

  test('write_file returns "Writing {fileName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'write_file', input: { path: 'src/output.ts' } }
    ]);
    assert.strictEqual(result, 'Writing output.ts');
  });

  test('search_workspace returns "Searching for ..."', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'search_workspace', input: { query: 'TODO' } }
    ]);
    assert.strictEqual(result, 'Searching for "TODO"');
  });

  test('search_workspace truncates long queries to 20 chars', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'search_workspace', input: { query: 'a very long search query that exceeds the limit' } }
    ]);
    assert.ok(result.startsWith('Searching for "'), 'Should start with Searching for');
    // The query inside quotes should be at most 20 chars
    const match = result.match(/"(.+?)"/);
    assert.ok(match, 'Should have quoted query');
    assert.ok(match![1].length <= 20, `Quoted query should be <= 20 chars, got ${match![1].length}`);
  });

  test('list_files returns "Listing files"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'list_files', input: { path: 'src/' } }
    ]);
    assert.strictEqual(result, 'Listing files');
  });

  test('run_terminal_command returns "Running command"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'run_terminal_command', input: { command: 'npm test' } }
    ]);
    assert.strictEqual(result, 'Running command');
  });

  test('find_definition with symbolName returns "Finding {symbolName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'find_definition', input: { path: 'src/main.ts', symbolName: 'handleRequest' } }
    ]);
    assert.strictEqual(result, 'Finding handleRequest');
  });

  test('find_references with symbolName returns "Finding usages of {symbolName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'find_references', input: { path: 'src/main.ts', symbolName: 'doWork' } }
    ]);
    assert.strictEqual(result, 'Finding usages of doWork');
  });

  test('get_diagnostics with path returns "Checking {fileName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'get_diagnostics', input: { path: 'src/utils.ts' } }
    ]);
    assert.strictEqual(result, 'Checking utils.ts');
  });

  test('get_document_symbols with path returns "Analyzing {fileName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'get_document_symbols', input: { path: 'src/index.ts' } }
    ]);
    assert.strictEqual(result, 'Analyzing index.ts');
  });

  test('unknown tool with fileName returns "Processing {fileName}"', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'custom_tool', input: { path: 'src/config.ts' } }
    ]);
    assert.strictEqual(result, 'Processing config.ts');
  });

  test('unknown tool without fileName returns "Working..."', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'custom_tool', input: {} }
    ]);
    assert.strictEqual(result, 'Working...');
  });

  test('uses last tool call in the array', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'read_file', input: { path: 'first.ts' } },
      { tool: 'write_file', input: { path: 'last.ts' } }
    ]);
    assert.strictEqual(result, 'Writing last.ts');
  });

  test('handles "name" field variant (not just "tool")', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { name: 'read_file', args: { path: 'src/app.ts' } }
    ]);
    assert.strictEqual(result, 'Reading app.ts');
  });

  test('handles "file" arg variant (not just "path")', () => {
    const result = AgentSummaryBuilder.generateStatusLine([
      { tool: 'read_file', input: { file: 'src/app.ts' } }
    ]);
    assert.strictEqual(result, 'Reading app.ts');
  });
});
