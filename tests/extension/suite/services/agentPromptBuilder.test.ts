import * as assert from 'assert';
import { AgentPromptBuilder } from '../../../../src/services/agent/agentPromptBuilder';

/**
 * Tests for AgentPromptBuilder — modular system prompt assembly.
 *
 * These tests verify that each prompt variant includes the expected sections
 * and excludes sections meant for other variants.
 */

// ─── Stub helpers ────────────────────────────────────────────────────

/** Minimal ToolRegistry stub that returns a small set of tools. */
function createStubToolRegistry(): any {
  const tools = [
    { name: 'read_file', description: 'Read a file', schema: { properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
    { name: 'write_file', description: 'Write a file', schema: { properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Content' } }, required: ['path', 'content'] } },
    { name: 'search_workspace', description: 'Search workspace', schema: { properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } },
    { name: 'list_files', description: 'List files', schema: { properties: { path: { type: 'string', description: 'Dir path' } }, required: [] } },
    { name: 'run_terminal_command', description: 'Run terminal command', schema: { properties: { command: { type: 'string', description: 'Command' } }, required: ['command'] } },
    { name: 'get_diagnostics', description: 'Get diagnostics', schema: { properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
    { name: 'get_document_symbols', description: 'Get document symbols', schema: { properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
    { name: 'find_definition', description: 'Find definition', schema: { properties: { path: { type: 'string', description: 'File path' }, symbolName: { type: 'string', description: 'Symbol name' } }, required: ['path', 'symbolName'] } },
    { name: 'find_references', description: 'Find references', schema: { properties: { path: { type: 'string', description: 'File path' }, symbolName: { type: 'string', description: 'Symbol name' } }, required: ['path', 'symbolName'] } },
    { name: 'find_implementations', description: 'Find implementations', schema: { properties: { path: { type: 'string', description: 'File path' }, symbolName: { type: 'string', description: 'Symbol name' } }, required: ['path', 'symbolName'] } },
    { name: 'find_symbol', description: 'Find symbol by name', schema: { properties: { symbolName: { type: 'string', description: 'Symbol name' } }, required: ['symbolName'] } },
    { name: 'get_hover_info', description: 'Get hover info', schema: { properties: { path: { type: 'string', description: 'File path' }, symbolName: { type: 'string', description: 'Symbol name' } }, required: ['path', 'symbolName'] } },
    { name: 'get_call_hierarchy', description: 'Get call hierarchy', schema: { properties: { path: { type: 'string', description: 'File path' }, symbolName: { type: 'string', description: 'Symbol name' } }, required: ['path', 'symbolName'] } },
    { name: 'get_type_hierarchy', description: 'Get type hierarchy', schema: { properties: { path: { type: 'string', description: 'File path' }, symbolName: { type: 'string', description: 'Symbol name' } }, required: ['path', 'symbolName'] } },
  ];

  return {
    getAll: () => tools,
    getOllamaToolDefinitions: () => tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: t.schema.properties, required: t.schema.required }
      }
    }))
  };
}

function createStubWorkspaceFolder(name: string, fsPath: string): any {
  return { name, uri: { fsPath } };
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('AgentPromptBuilder', () => {
  let builder: AgentPromptBuilder;
  const singleRoot = [createStubWorkspaceFolder('myproject', '/home/user/myproject')];
  const multiRoot = [
    createStubWorkspaceFolder('frontend', '/home/user/frontend'),
    createStubWorkspaceFolder('backend', '/home/user/backend'),
  ];

  setup(() => {
    builder = new AgentPromptBuilder(createStubToolRegistry());
  });

  // ── Native tool prompt ──────────────────────────────────────────

  suite('buildNativeToolPrompt', () => {
    test('includes all mandatory behavioral sections', () => {
      const prompt = builder.buildNativeToolPrompt(singleRoot, singleRoot[0]);

      // Identity
      assert.ok(prompt.includes('expert coding agent'), 'Missing identity section');

      // Workspace info
      assert.ok(prompt.includes('/home/user/myproject'), 'Missing workspace path');

      // Tone and style
      assert.ok(prompt.includes('COMMUNICATION RULES'), 'Missing communication rules');

      // Task execution
      assert.ok(prompt.includes('TASK EXECUTION RULES'), 'Missing task execution rules');

      // Tool usage policy
      assert.ok(prompt.includes('TOOL USAGE RULES'), 'Missing tool usage rules');

      // Safety
      assert.ok(prompt.includes('SAFETY AND REVERSIBILITY'), 'Missing safety rules');

      // Code navigation
      assert.ok(prompt.includes('CODE NAVIGATION STRATEGY'), 'Missing code navigation');

      // User-provided context
      assert.ok(prompt.includes('USER-PROVIDED CONTEXT'), 'Missing user context');

      // Search tips
      assert.ok(prompt.includes('SEARCH TIPS'), 'Missing search tips');

      // Scratch dir
      assert.ok(prompt.includes('.ollama-copilot-scratch'), 'Missing scratch dir');

      // Completion signal
      assert.ok(prompt.includes('[TASK_COMPLETE]'), 'Missing completion signal');
    });

    test('does NOT include XML fallback sections', () => {
      const prompt = builder.buildNativeToolPrompt(singleRoot, singleRoot[0]);

      assert.ok(!prompt.includes('TOOLS:'), 'Native prompt should not include tool definitions');
      assert.ok(!prompt.includes('FORMAT - Always use'), 'Native prompt should not include XML format');
    });

    test('multi-root workspace lists all folders', () => {
      const prompt = builder.buildNativeToolPrompt(multiRoot, multiRoot[0]);

      assert.ok(prompt.includes('multi-root workspace'), 'Missing multi-root label');
      assert.ok(prompt.includes('frontend'), 'Missing frontend folder');
      assert.ok(prompt.includes('backend'), 'Missing backend folder');
      assert.ok(prompt.includes('/home/user/frontend'), 'Missing frontend path');
      assert.ok(prompt.includes('/home/user/backend'), 'Missing backend path');
    });

    test('native tool prompt mentions parallel tool calls', () => {
      const prompt = builder.buildNativeToolPrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('multiple tool calls are independent'), 'Missing parallel batching');
    });
  });

  // ── XML fallback prompt ─────────────────────────────────────────

  suite('buildXmlFallbackPrompt', () => {
    test('includes tool definitions and XML format examples', () => {
      const prompt = builder.buildXmlFallbackPrompt(singleRoot, singleRoot[0]);

      assert.ok(prompt.includes('TOOLS:'), 'Missing TOOLS: section');
      assert.ok(prompt.includes('read_file:'), 'Missing read_file tool definition');
      assert.ok(prompt.includes('write_file:'), 'Missing write_file tool definition');
      assert.ok(prompt.includes('FORMAT - Always use'), 'Missing tool call format');
      assert.ok(prompt.includes('<tool_call>'), 'Missing XML example');
    });

    test('also includes all mandatory behavioral sections', () => {
      const prompt = builder.buildXmlFallbackPrompt(singleRoot, singleRoot[0]);

      assert.ok(prompt.includes('expert coding agent'), 'Missing identity');
      assert.ok(prompt.includes('COMMUNICATION RULES'), 'Missing tone');
      assert.ok(prompt.includes('TASK EXECUTION RULES'), 'Missing tasks');
      assert.ok(prompt.includes('SAFETY AND REVERSIBILITY'), 'Missing safety');
      assert.ok(prompt.includes('[TASK_COMPLETE]'), 'Missing completion signal');
    });
  });

  // ── Explore mode prompt ─────────────────────────────────────────

  suite('buildExplorePrompt', () => {
    test('includes read-only constraint', () => {
      const prompt = builder.buildExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('STRICT CONSTRAINTS'), 'Missing strict constraints');
      assert.ok(prompt.includes('MUST NOT create, modify, or delete'), 'Missing read-only rule');
    });

    test('includes exploration strategy', () => {
      const prompt = builder.buildExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('EXPLORATION STRATEGY'), 'Missing exploration strategy');
    });

    test('native mode does NOT include tool definitions in text', () => {
      const prompt = builder.buildExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(!prompt.includes('TOOLS (read-only):'), 'Native explore should not have inline tool definitions');
    });

    test('XML fallback mode includes read-only tool definitions', () => {
      const prompt = builder.buildExplorePrompt(singleRoot, singleRoot[0], false);
      assert.ok(prompt.includes('TOOLS (read-only):'), 'XML explore should have tool definitions');
      assert.ok(prompt.includes('read_file:'), 'Should list read_file');
      assert.ok(!prompt.includes('write_file:'), 'Should NOT list write_file');
      assert.ok(!prompt.includes('run_terminal_command:'), 'Should NOT list run_terminal_command');
    });
  });

  // ── Plan mode prompt ────────────────────────────────────────────

  suite('buildPlanPrompt', () => {
    test('includes planning process', () => {
      const prompt = builder.buildPlanPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('PLANNING PROCESS'), 'Missing planning process');
      assert.ok(prompt.includes('UNDERSTAND REQUIREMENTS'), 'Missing step 1');
      assert.ok(prompt.includes('DESIGN SOLUTION'), 'Missing step 3');
      assert.ok(prompt.includes('OUTPUT STRUCTURED PLAN'), 'Missing step 4');
    });

    test('includes read-only constraint', () => {
      const prompt = builder.buildPlanPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('MUST NOT create, modify, or delete'), 'Missing read-only rule');
    });
  });

  // ── Security review prompt ──────────────────────────────────────

  suite('buildSecurityReviewPrompt', () => {
    test('includes vulnerability categories and confidence scoring', () => {
      const prompt = builder.buildSecurityReviewPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('WHAT TO LOOK FOR'), 'Missing vulnerability categories');
      assert.ok(prompt.includes('SQL injection'), 'Missing SQL injection');
      assert.ok(prompt.includes('CONFIDENCE SCORING'), 'Missing confidence scoring');
      assert.ok(prompt.includes('FALSE POSITIVE FILTERING'), 'Missing false positive filtering');
    });

    test('XML fallback includes tools with run_terminal_command', () => {
      const prompt = builder.buildSecurityReviewPrompt(singleRoot, singleRoot[0], false);
      assert.ok(prompt.includes('TOOLS (read-only + git):'), 'Missing security tool definitions');
      assert.ok(prompt.includes('run_terminal_command:'), 'Should include terminal for git commands');
      assert.ok(prompt.includes('read_file:'), 'Should include read_file');
      assert.ok(!prompt.includes('write_file:'), 'Should NOT include write_file');
    });
  });

  // ── Tool definition helpers ─────────────────────────────────────

  suite('getReadOnlyToolDefinitions', () => {
    test('returns only read-only tools', () => {
      const defs = builder.getReadOnlyToolDefinitions();
      const names = defs.map((d: any) => d.function?.name);

      assert.ok(names.includes('read_file'), 'Missing read_file');
      assert.ok(names.includes('search_workspace'), 'Missing search_workspace');
      assert.ok(names.includes('list_files'), 'Missing list_files');
      assert.ok(names.includes('find_definition'), 'Missing find_definition');

      assert.ok(!names.includes('write_file'), 'Should NOT include write_file');
      assert.ok(!names.includes('run_terminal_command'), 'Should NOT include run_terminal_command');
    });

    test('returns exactly 12 tools', () => {
      const defs = builder.getReadOnlyToolDefinitions();
      assert.strictEqual(defs.length, 12, `Expected 12 read-only tools, got ${defs.length}`);
    });
  });

  suite('getSecurityReviewToolDefinitions', () => {
    test('includes run_terminal_command but not write_file', () => {
      const defs = builder.getSecurityReviewToolDefinitions();
      const names = defs.map((d: any) => d.function?.name);

      assert.ok(names.includes('run_terminal_command'), 'Should include run_terminal_command');
      assert.ok(!names.includes('write_file'), 'Should NOT include write_file');
    });

    test('returns exactly 13 tools (12 read-only + terminal)', () => {
      const defs = builder.getSecurityReviewToolDefinitions();
      assert.strictEqual(defs.length, 13, `Expected 13 review tools, got ${defs.length}`);
    });
  });
});
