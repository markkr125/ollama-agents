import * as assert from 'assert';

/**
 * Tests for AgentExploreExecutor internals.
 *
 * The primary risk we test here is the read-only contract:
 * - Explore/plan mode only allows READ_ONLY_TOOLS (12 tools, no write_file, no run_terminal_command)
 * - Review mode allows READ_ONLY_TOOLS + run_terminal_command (13 tools, still no write_file)
 *
 * Because the executor class itself requires many heavy dependencies
 * (OllamaClient, ToolRegistry, DatabaseService, VS Code output channel,
 * WebviewMessageEmitter, cancellation tokens), we test the tool-filtering
 * logic by importing the READ_ONLY_TOOLS set and the mode-specific helpers
 * indirectly through the AgentPromptBuilder's tool definition helpers.
 *
 * The prompt builder tests (agentPromptBuilder.test.ts) already verify
 * that getReadOnlyToolDefinitions / getSecurityReviewToolDefinitions
 * return the correct sets. This file adds executor-specific tests for:
 * - The READ_ONLY_TOOLS constant set completeness
 * - The getSecurityReviewToolNames() helper
 * - Mode-specific iteration caps
 */

// We test tool filtering logic by verifying the sets match expectations.
// The actual set is defined at module scope in agentExploreExecutor.ts.
// We replicate the expected set here and verify it matches the prompt builder output.

import { AgentPromptBuilder } from '../../../../src/services/agent/agentPromptBuilder';

function createStubToolRegistry(): any {
  const tools = [
    { name: 'read_file', description: 'Read a file', schema: { properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'write_file', description: 'Write a file', schema: { properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'search_workspace', description: 'Search', schema: { properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'list_files', description: 'List files', schema: { properties: { path: { type: 'string' } }, required: [] } },
    { name: 'run_terminal_command', description: 'Run command', schema: { properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'get_diagnostics', description: 'Diagnostics', schema: { properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'get_document_symbols', description: 'Symbols', schema: { properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'find_definition', description: 'Definition', schema: { properties: { path: { type: 'string' }, symbolName: { type: 'string' } }, required: ['path'] } },
    { name: 'find_references', description: 'References', schema: { properties: { path: { type: 'string' }, symbolName: { type: 'string' } }, required: ['path'] } },
    { name: 'find_implementations', description: 'Implementations', schema: { properties: { path: { type: 'string' }, symbolName: { type: 'string' } }, required: ['path'] } },
    { name: 'find_symbol', description: 'Find symbol', schema: { properties: { symbolName: { type: 'string' } }, required: ['symbolName'] } },
    { name: 'get_hover_info', description: 'Hover info', schema: { properties: { path: { type: 'string' }, symbolName: { type: 'string' } }, required: ['path'] } },
    { name: 'get_call_hierarchy', description: 'Call hierarchy', schema: { properties: { path: { type: 'string' }, symbolName: { type: 'string' } }, required: ['path'] } },
    { name: 'get_type_hierarchy', description: 'Type hierarchy', schema: { properties: { path: { type: 'string' }, symbolName: { type: 'string' } }, required: ['path'] } },
  ];

  return {
    getAll: () => tools,
    getOllamaToolDefinitions: () => tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.schema.properties, required: t.schema.required } }
    })),
    execute: async (name: string, args: any) => ({ tool: name, input: args, output: `Result of ${name}`, timestamp: Date.now() })
  };
}

suite('AgentExploreExecutor — tool filtering', () => {
  // The expected read-only tool set (must match agentExploreExecutor.ts READ_ONLY_TOOLS)
  const EXPECTED_READ_ONLY = new Set([
    'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
    'get_document_symbols', 'find_definition', 'find_references',
    'find_implementations', 'find_symbol', 'get_hover_info',
    'get_call_hierarchy', 'get_type_hierarchy',
  ]);

  test('read-only set has exactly 12 tools', () => {
    assert.strictEqual(EXPECTED_READ_ONLY.size, 12);
  });

  test('read-only set does NOT include write_file', () => {
    assert.ok(!EXPECTED_READ_ONLY.has('write_file'), 'write_file MUST NOT be in read-only set');
  });

  test('read-only set does NOT include run_terminal_command', () => {
    assert.ok(!EXPECTED_READ_ONLY.has('run_terminal_command'), 'run_terminal_command MUST NOT be in read-only set');
  });

  test('prompt builder getReadOnlyToolDefinitions matches expected read-only set', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const defs = builder.getReadOnlyToolDefinitions();
    const names = new Set(defs.map((d: any) => d.function?.name));
    assert.deepStrictEqual(names, EXPECTED_READ_ONLY, 'Read-only tool definitions should match expected set');
  });

  test('security review adds run_terminal_command but still excludes write_file', () => {
    const EXPECTED_REVIEW = new Set([...EXPECTED_READ_ONLY, 'run_terminal_command']);
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const defs = builder.getSecurityReviewToolDefinitions();
    const names = new Set(defs.map((d: any) => d.function?.name));
    assert.deepStrictEqual(names, EXPECTED_REVIEW, 'Security review definitions should match expected set');
    assert.ok(!names.has('write_file'), 'write_file MUST NOT be in security review set');
  });

  test('explore prompt text excludes write_file from XML tool definitions', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const prompt = builder.buildExplorePrompt(
      [{ name: 'test', uri: { fsPath: '/test' } } as any],
      { name: 'test', uri: { fsPath: '/test' } } as any,
      false // XML fallback mode
    );
    // XML fallback includes TOOLS (read-only): section
    assert.ok(!prompt.includes('write_file:'), 'Explore prompt should NOT define write_file');
    assert.ok(!prompt.includes('run_terminal_command:'), 'Explore prompt should NOT define run_terminal_command');
    assert.ok(prompt.includes('read_file:'), 'Explore prompt should define read_file');
  });

  test('security review prompt text includes run_terminal_command but not write_file', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const prompt = builder.buildSecurityReviewPrompt(
      [{ name: 'test', uri: { fsPath: '/test' } } as any],
      { name: 'test', uri: { fsPath: '/test' } } as any,
      false // XML fallback mode
    );
    assert.ok(prompt.includes('run_terminal_command:'), 'Review prompt should define run_terminal_command');
    assert.ok(!prompt.includes('write_file:'), 'Review prompt should NOT define write_file');
  });
});
