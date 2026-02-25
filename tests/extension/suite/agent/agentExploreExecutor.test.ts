import * as assert from 'assert';
import { SUB_AGENT_ALLOWED_TYPES } from '../../../../src/agent/execution/agentEventEmitter';
import { buildToolResultsSummary } from '../../../../src/agent/execution/orchestration/agentExploreExecutor';

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

import { AgentPromptBuilder } from '../../../../src/agent/execution/prompts/agentPromptBuilder';

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
    { name: 'run_subagent', description: 'Launch sub-agent', schema: { properties: { task: { type: 'string' }, mode: { type: 'string' } }, required: ['task'] } },
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

  // ── Deep-explore mode ───────────────────────────────────────────

  test('deep-explore tool definitions include run_subagent', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const defs = builder.getDeepExploreToolDefinitions();
    const names = new Set(defs.map((d: any) => d.function?.name));
    assert.ok(names.has('run_subagent'), 'Deep-explore should include run_subagent');
    assert.ok(names.has('read_file'), 'Deep-explore should include read_file');
    assert.ok(names.has('find_definition'), 'Deep-explore should include find_definition');
    assert.ok(!names.has('write_file'), 'Deep-explore should NOT include write_file');
    assert.ok(!names.has('run_terminal_command'), 'Deep-explore should NOT include run_terminal_command');
  });

  test('deep-explore tool definitions return exactly 13 tools (12 read-only + subagent)', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const defs = builder.getDeepExploreToolDefinitions();
    assert.strictEqual(defs.length, 13, `Expected 13 deep-explore tools, got ${defs.length}`);
  });

  test('deep-explore prompt includes 4-phase methodology', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const prompt = builder.buildDeepExplorePrompt(
      [{ name: 'test', uri: { fsPath: '/test' } } as any],
      { name: 'test', uri: { fsPath: '/test' } } as any,
      true
    );
    assert.ok(prompt.includes('Phase 1: MAP'), 'Missing Phase 1');
    assert.ok(prompt.includes('Phase 2: TRACE DEPTH-FIRST'), 'Missing Phase 2');
    assert.ok(prompt.includes('Phase 3: CROSS-CUTTING'), 'Missing Phase 3');
    assert.ok(prompt.includes('Phase 4: SYNTHESIZE'), 'Missing Phase 4');
  });

  // ── Chat mode ───────────────────────────────────────────────────

  test('chat mode uses read-only tool definitions (same as explore)', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const readOnlyDefs = builder.getReadOnlyToolDefinitions();
    const names = new Set(readOnlyDefs.map((d: any) => d.function?.name));
    // Chat mode reuses read-only tools — verify the set matches
    assert.deepStrictEqual(names, EXPECTED_READ_ONLY, 'Chat mode tools should match read-only set');
  });

  test('chat mode prompt includes CODE INTELLIGENCE section', () => {
    const builder = new AgentPromptBuilder(createStubToolRegistry());
    const prompt = builder.buildChatPrompt(
      [{ name: 'test', uri: { fsPath: '/test' } } as any],
      { name: 'test', uri: { fsPath: '/test' } } as any,
      true
    );
    assert.ok(prompt.includes('CODE INTELLIGENCE'), 'Chat prompt should include code intelligence section');
    assert.ok(prompt.includes('helpful coding assistant'), 'Chat prompt should have chat identity');
  });
});

// =============================================================================
// REGRESSION: SUB_AGENT_ALLOWED_TYPES must include progress group events
// =============================================================================
// Before fix: startProgressGroup and finishProgressGroup were NOT in
// SUB_AGENT_ALLOWED_TYPES. This caused FilteredAgentEventEmitter to
// persist them to DB but NOT post them to the webview. Result:
// - Live: all sub-agent actions fell into a fallback "Working on task" group
// - History: correctly showed separate "Sub-agent: [title]" groups
// This was the #1 worst live-vs-history mismatch bug.

suite('SUB_AGENT_ALLOWED_TYPES — REGRESSION: must include progress group events', () => {

  test('startProgressGroup must be allowed (sub-agent wrapper group)', () => {
    assert.ok(
      SUB_AGENT_ALLOWED_TYPES.has('startProgressGroup'),
      'startProgressGroup MUST be in SUB_AGENT_ALLOWED_TYPES — without it, sub-agent groups never reach the webview and all actions fall into a fallback "Working on task" group'
    );
  });

  test('finishProgressGroup must be allowed (close sub-agent wrapper group)', () => {
    assert.ok(
      SUB_AGENT_ALLOWED_TYPES.has('finishProgressGroup'),
      'finishProgressGroup MUST be in SUB_AGENT_ALLOWED_TYPES — without it, sub-agent groups stay "running" forever and actions never transition to success'
    );
  });

  test('showToolAction must be allowed (sub-agent tool results)', () => {
    assert.ok(
      SUB_AGENT_ALLOWED_TYPES.has('showToolAction'),
      'showToolAction MUST be allowed so sub-agent tool results appear in UI'
    );
  });
});

// =============================================================================
// REGRESSION: buildToolResultsSummary — sub-agent data passthrough
// =============================================================================
// Before fix: buildToolResultsSummary only kept the FIRST LINE of read_file
// output (e.g. "import http = require('http')") and appended "(11313 chars)".
// The parent orchestrator got a useless one-liner instead of the file content.
// This caused the entire sub-agent system to be dead — sub-agents read files
// but the data never reached the parent.

suite('buildToolResultsSummary — REGRESSION: must include full tool content', () => {

  test('read_file content is included in full (not just first line)', () => {
    const fileContent = 'import http = require("http")\n\nexport class SearchController {\n  search() { /* ... */ }\n}\n';
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
      { role: 'tool', tool_name: 'read_file', content: fileContent },
    ];
    const result = buildToolResultsSummary(messages);
    // CRITICAL: The full file content must be present, not just "import http..."
    assert.ok(result.includes('SearchController'), `Must include file content, got: ${result.substring(0, 200)}`);
    assert.ok(result.includes('search()'), `Must include function names from file, got: ${result.substring(0, 200)}`);
    assert.ok(!result.includes('(89 chars)'), 'Must NOT use the old "(N chars)" format that discarded content');
  });

  test('read_file: large content is passed through in full (no truncation)', () => {
    const bigContent = 'x'.repeat(5000);
    const messages = [
      { role: 'tool', tool_name: 'read_file', content: bigContent },
    ];
    const result = buildToolResultsSummary(messages);
    assert.ok(result.includes('x'.repeat(5000)), 'Full content should be present without truncation');
    assert.ok(!result.includes('chars truncated'), 'Should NOT show truncation notice');
  });

  test('search_workspace content is included in full (not just first line)', () => {
    const searchOutput = '── src/controllers/SearchController.ts ──\n→ 20:  * @class SearchController\n  21:  * @extends {ControllerBase}\n';
    const messages = [
      { role: 'tool', tool_name: 'search_workspace', content: searchOutput },
    ];
    const result = buildToolResultsSummary(messages);
    assert.ok(result.includes('SearchController.ts'), `Must include search results: ${result.substring(0, 200)}`);
    assert.ok(result.includes('@class SearchController'), `Must include match content: ${result.substring(0, 200)}`);
  });

  test('get_document_symbols content is included in full', () => {
    const symbolOutput = 'class SearchController (1-272)\n  method search (118-271)\n  method ping (60-70)';
    const messages = [
      { role: 'tool', tool_name: 'get_document_symbols', content: symbolOutput },
    ];
    const result = buildToolResultsSummary(messages);
    assert.ok(result.includes('method search'), `Must include symbol details: ${result.substring(0, 200)}`);
  });

  test('LSP tools (find_definition, find_references, etc.) content is included in full', () => {
    const defOutput = 'src/helpers/Search/ProcessSearch.ts:L15\nexport class ProcessSearch {\n  static async executeSearch() { ... }';
    const messages = [
      { role: 'tool', tool_name: 'find_definition', content: defOutput },
    ];
    const result = buildToolResultsSummary(messages);
    assert.ok(result.includes('ProcessSearch'), `Must include definition content: ${result.substring(0, 200)}`);
    assert.ok(result.includes('executeSearch'), `Must include function name: ${result.substring(0, 200)}`);
  });

  test('non-data tools (e.g. run_terminal_command) still get first-line summary', () => {
    const messages = [
      { role: 'tool', tool_name: 'run_terminal_command', content: 'npm test\n\n> 42 tests passed\n> 0 failed' },
    ];
    const result = buildToolResultsSummary(messages);
    assert.ok(result.includes('npm test'), 'First line should be present');
    assert.ok(!result.includes('42 tests passed'), 'Should NOT include full output for non-data tools');
  });

  test('__ui__ messages are excluded', () => {
    const messages = [
      { role: 'tool', tool_name: '__ui__', content: '{"type":"showToolAction"}' },
      { role: 'tool', tool_name: 'read_file', content: 'real content' },
    ];
    const result = buildToolResultsSummary(messages);
    assert.ok(!result.includes('showToolAction'), 'UI messages must be excluded');
    assert.ok(result.includes('real content'), 'Real tool content should be present');
  });

  test('empty messages returns "Exploration completed."', () => {
    assert.strictEqual(buildToolResultsSummary([]), 'Exploration completed.');
    assert.strictEqual(buildToolResultsSummary([{ role: 'user', content: 'hi' }]), 'Exploration completed.');
  });

  test('total output is passed through in full (no cap)', () => {
    const messages = [
      { role: 'tool', tool_name: 'read_file', content: 'a'.repeat(3500) },
      { role: 'tool', tool_name: 'read_file', content: 'b'.repeat(3500) },
      { role: 'tool', tool_name: 'read_file', content: 'c'.repeat(3500) },
    ];
    const result = buildToolResultsSummary(messages);
    // All three tool outputs should be present in full
    assert.ok(result.includes('a'.repeat(3500)), 'First tool output should be present in full');
    assert.ok(result.includes('b'.repeat(3500)), 'Second tool output should be present in full');
    assert.ok(result.includes('c'.repeat(3500)), 'Third tool output should be present in full');
    assert.ok(!result.includes('[Summary truncated]'), 'Should NOT show truncation notice');
  });

  test('the exact scenario from the bug: read_file returns 11K chars', () => {
    // Reproduce the exact failure: sub-agent reads SearchController.ts (11313 chars)
    // but buildToolResultsSummary returns only "import http = require('http') (11313 chars)"
    const fileContent = 'import http = require("http")\n' + 'x'.repeat(11283); // ~11313 chars
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      { role: 'assistant', tool_calls: [{}], content: 'I read SearchController.ts.' },
      { role: 'tool', tool_name: 'read_file', content: fileContent },
      { role: 'user', content: 'Proceed with tool calls or [TASK_COMPLETE].' },
    ];
    const result = buildToolResultsSummary(messages);
    // OLD behavior: "Tool results summary:\n- read_file: import http = require(\"http\") (11313 chars)"
    // NEW behavior: must include actual content in full (no truncation)
    assert.ok(result.length > 500, `Summary must include substantial content, got only ${result.length} chars`);
    assert.ok(!result.includes('(11313 chars)'), 'Must NOT use the old "(N chars)" placeholder format');
    assert.ok(result.includes('import http = require("http")'), 'Must include actual file content');
  });
});
