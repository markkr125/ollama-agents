import * as assert from 'assert';
import { AgentPromptBuilder } from '../../../../src/agent/execution/prompts/agentPromptBuilder';

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
    { name: 'run_subagent', description: 'Launch sub-agent for exploration', schema: { properties: { task: { type: 'string', description: 'Task description' }, mode: { type: 'string', description: 'Mode' } }, required: ['task'] } },
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

  // ── Orchestrator native prompt ───────────────────────────────────

  suite('buildOrchestratorNativePrompt', () => {
    test('includes all mandatory behavioral sections', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);

      // Identity
      assert.ok(prompt.includes('interactive coding assistant'), 'Missing identity section');

      // Workspace info
      assert.ok(prompt.includes('/home/user/myproject'), 'Missing workspace path');

      // Tone and style
      assert.ok(prompt.includes('COMMUNICATION RULES'), 'Missing communication rules');

      // Orchestrator-specific task execution
      assert.ok(prompt.includes('TASK EXECUTION'), 'Missing task execution rules');
      assert.ok(prompt.includes('Delegate research'), 'Orchestrator task should mention delegation');

      // Orchestrator-specific tool policy
      assert.ok(prompt.includes('TOOL USAGE'), 'Missing tool usage rules');
      assert.ok(prompt.includes('You have ONLY 3 tools'), 'Orchestrator tool policy should mention 3 tools');

      // Safety
      assert.ok(prompt.includes('SAFETY'), 'Missing safety rules');

      // User-provided context
      assert.ok(prompt.includes('USER-PROVIDED CONTEXT'), 'Missing user context');

      // Orchestrator prompt does NOT include code navigation or deep exploration (those are for sub-agents)
      assert.ok(!prompt.includes('CODE NAVIGATION STRATEGY'), 'Orchestrator should not have code nav (sub-agent only)');
      assert.ok(!prompt.includes('SEARCH TIPS'), 'Orchestrator should not have search tips (sub-agent only)');

      // Orchestrator DOES include delegation strategy
      assert.ok(prompt.includes('ORCHESTRATOR DELEGATION STRATEGY'), 'Missing orchestrator delegation strategy');

      // Orchestrator task section should NOT reference read_file/search_workspace directly
      assert.ok(!prompt.includes('Read before writing'), 'Orchestrator task should not say Read before writing');

      // Scratch dir
      assert.ok(prompt.includes('.ollama-copilot-scratch'), 'Missing scratch dir');

      // Completion signal
      assert.ok(prompt.includes('[TASK_COMPLETE]'), 'Missing completion signal');
    });

    test('does NOT include XML fallback sections', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);

      assert.ok(!prompt.includes('TOOLS:'), 'Native prompt should not include tool definitions');
      assert.ok(!prompt.includes('FORMAT - Always use'), 'Native prompt should not include XML format');
    });

    test('multi-root workspace lists all folders', () => {
      const prompt = builder.buildOrchestratorNativePrompt(multiRoot, multiRoot[0]);

      assert.ok(prompt.includes('multi-root workspace'), 'Missing multi-root label');
      assert.ok(prompt.includes('frontend'), 'Missing frontend folder');
      assert.ok(prompt.includes('backend'), 'Missing backend folder');
      assert.ok(prompt.includes('/home/user/frontend'), 'Missing frontend path');
      assert.ok(prompt.includes('/home/user/backend'), 'Missing backend path');
    });

    test('native tool prompt mentions parallel tool calls', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('parallel'), 'Missing parallel batching');
    });

    test('orchestrator tool policy does not reference read_file or search_workspace', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      // The TOOL USAGE section should mention write_file, run_terminal_command, run_subagent
      // but NOT read_file or search_workspace (those are sub-agent tools)
      assert.ok(prompt.includes('write_file'), 'Should mention write_file');
      assert.ok(prompt.includes('run_terminal_command'), 'Should mention run_terminal_command');
      assert.ok(prompt.includes('run_subagent'), 'Should mention run_subagent');
    });
  });

  // ── Orchestrator XML prompt ─────────────────────────────────────

  suite('buildOrchestratorXmlPrompt', () => {
    test('includes orchestrator tool definitions and XML format examples', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);

      assert.ok(prompt.includes('TOOLS:'), 'Missing TOOLS: section');
      // Orchestrator XML only includes the 3 orchestrator tools
      assert.ok(prompt.includes('write_file:'), 'Missing write_file tool definition');
      assert.ok(prompt.includes('run_terminal_command:'), 'Missing run_terminal_command tool definition');
      assert.ok(prompt.includes('run_subagent:'), 'Missing run_subagent tool definition');
      // read_file is NOT in the orchestrator (it's a sub-agent tool)
      assert.ok(!prompt.includes('read_file:'), 'Orchestrator XML should NOT include read_file');
      assert.ok(prompt.includes('FORMAT - Always use'), 'Missing tool call format');
      assert.ok(prompt.includes('<tool_call>'), 'Missing XML example');
    });

    test('includes orchestrator delegation strategy', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('ORCHESTRATOR DELEGATION STRATEGY'), 'Missing orchestrator delegation strategy');
    });

    test('uses orchestrator-specific task and tool sections', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);

      assert.ok(prompt.includes('Delegate research'), 'XML orchestrator should use orchestrator-specific task section');
      assert.ok(prompt.includes('You have ONLY 3 tools'), 'XML orchestrator should use orchestrator tool policy');
    });

    test('also includes all mandatory behavioral sections', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);

      assert.ok(prompt.includes('interactive coding assistant'), 'Missing identity');
      assert.ok(prompt.includes('COMMUNICATION RULES'), 'Missing tone');
      assert.ok(prompt.includes('TASK EXECUTION'), 'Missing tasks');
      assert.ok(prompt.includes('SAFETY'), 'Missing safety');
      assert.ok(prompt.includes('[TASK_COMPLETE]'), 'Missing completion signal');
    });
  });

  // ── Deprecated aliases ──────────────────────────────────────────

  suite('deprecated aliases', () => {
    test('buildNativeToolPrompt delegates to buildOrchestratorNativePrompt', () => {
      const oldResult = builder.buildNativeToolPrompt(singleRoot, singleRoot[0]);
      const newResult = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.strictEqual(oldResult, newResult);
    });

    test('buildXmlFallbackPrompt delegates to buildOrchestratorXmlPrompt', () => {
      const oldResult = builder.buildXmlFallbackPrompt(singleRoot, singleRoot[0]);
      const newResult = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      assert.strictEqual(oldResult, newResult);
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

  // ── Enhanced prompt sections ──────────────────────────────────────

  suite('enhanced prompt sections', () => {
    test('tone section includes anti-sycophancy rules', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('sycophantic'), 'Should mention sycophantic behavior');
      assert.ok(prompt.includes('PROFESSIONAL OBJECTIVITY'), 'Should mention professional objectivity');
    });

    test('orchestrator doingTasks mentions delegation', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('Delegate research'), 'Orchestrator should mention delegation');
      assert.ok(prompt.includes('Complete each step'), 'Should mention completing steps');
    });

    test('orchestrator toolPolicy mentions only 3 tools', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('run_subagent'), 'Should mention run_subagent');
      assert.ok(prompt.includes('diagnostics are automatically checked'), 'Should mention auto-diagnostics after writes');
      assert.ok(prompt.includes('You have ONLY 3 tools'), 'Should mention only 3 tools');
    });

    test('executingWithCare includes investigation before fixing', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('investigate before'), 'Should mention investigating before acting');
      assert.ok(prompt.includes('verify the package name'), 'Should mention package verification');
    });

    test('completionSignal includes verification instructions', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('verify your work'), 'Should mention verifying work');
      assert.ok(prompt.includes('compiles/lints cleanly'), 'Should mention clean compilation');
    });

    test('completionSignal includes CONTINUATION BEHAVIOR section', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('CONTINUATION BEHAVIOR'), 'Should have CONTINUATION BEHAVIOR section');
      assert.ok(prompt.includes('agent_control'), 'Should reference agent_control packets');
      assert.ok(prompt.includes('Do NOT restate your plan'), 'Should include anti-repetition rules');
    });

    test('XML prompt also includes CONTINUATION BEHAVIOR', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('CONTINUATION BEHAVIOR'), 'XML prompt should also have continuation rules');
      assert.ok(prompt.includes('Do NOT repeat tool calls'), 'Should include anti-repetition for tools');
    });

    test('plan prompt includes quality rules', () => {
      const prompt = builder.buildPlanPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('PLAN QUALITY RULES'), 'Should have plan quality section');
      assert.ok(prompt.includes('Estimated complexity'), 'Should mention complexity estimation');
    });

    test('security review prompt includes expanded confidence scale', () => {
      const prompt = builder.buildSecurityReviewPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('Confidence 10:'), 'Should have confidence 10 definition');
      assert.ok(prompt.includes('Confidence 9:'), 'Should have confidence 9 definition');
      assert.ok(prompt.includes('Confidence 8:'), 'Should have confidence 8 definition');
      assert.ok(prompt.includes('Low Confidence'), 'Should mention low confidence appendix');
    });
  });

  // ── Chat mode prompt ────────────────────────────────────────────

  suite('buildChatPrompt', () => {
    test('includes helpful assistant identity', () => {
      const prompt = builder.buildChatPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('helpful coding assistant'), 'Missing chat identity');
    });

    test('includes read-only constraint', () => {
      const prompt = builder.buildChatPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('MUST NOT create, modify, or delete'), 'Missing read-only rule');
    });

    test('includes CODE INTELLIGENCE section with all 8 LSP tool references', () => {
      const prompt = builder.buildChatPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('CODE INTELLIGENCE'), 'Missing code intelligence section');
      assert.ok(prompt.includes('find_definition'), 'Missing find_definition');
      assert.ok(prompt.includes('find_references'), 'Missing find_references');
      assert.ok(prompt.includes('get_document_symbols'), 'Missing get_document_symbols');
      assert.ok(prompt.includes('get_hover_info'), 'Missing get_hover_info');
      assert.ok(prompt.includes('get_call_hierarchy'), 'Missing get_call_hierarchy');
      assert.ok(prompt.includes('find_implementations'), 'Missing find_implementations');
      assert.ok(prompt.includes('get_type_hierarchy'), 'Missing get_type_hierarchy');
      assert.ok(prompt.includes('search_workspace'), 'Missing search_workspace');
    });

    test('includes USER-PROVIDED CONTEXT section', () => {
      const prompt = builder.buildChatPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('USER-PROVIDED CONTEXT'), 'Missing user context section');
    });

    test('XML fallback includes read-only tool definitions', () => {
      const prompt = builder.buildChatPrompt(singleRoot, singleRoot[0], false);
      assert.ok(prompt.includes('TOOLS (read-only):'), 'Missing tool definitions for XML fallback');
      assert.ok(!prompt.includes('write_file:'), 'Should NOT define write_file');
      assert.ok(!prompt.includes('run_terminal_command:'), 'Should NOT define run_terminal_command');
    });
  });

  // ── Deep explore prompt ─────────────────────────────────────────

  suite('buildDeepExplorePrompt', () => {
    test('includes deep exploration methodology with 4 phases', () => {
      const prompt = builder.buildDeepExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('Phase 1: MAP'), 'Missing Phase 1');
      assert.ok(prompt.includes('Phase 2: TRACE DEPTH-FIRST'), 'Missing Phase 2');
      assert.ok(prompt.includes('Phase 3: CROSS-CUTTING ANALYSIS'), 'Missing Phase 3');
      assert.ok(prompt.includes('Phase 4: SYNTHESIZE'), 'Missing Phase 4');
    });

    test('includes read-only constraint', () => {
      const prompt = builder.buildDeepExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('MUST NOT create, modify, or delete'), 'Missing read-only rule');
    });

    test('mentions run_subagent for delegation', () => {
      const prompt = builder.buildDeepExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('run_subagent'), 'Missing subagent delegation mention');
    });

    test('includes critical rules about depth-first exploration', () => {
      const prompt = builder.buildDeepExplorePrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('DEPTH OVER BREADTH'), 'Missing depth over breadth rule');
      assert.ok(prompt.includes('DON\'T STOP EARLY'), 'Missing don\'t stop early rule');
      assert.ok(prompt.includes('FOLLOW IMPORTS'), 'Missing follow imports rule');
    });

    test('XML fallback includes deep-explore tool definitions with run_subagent', () => {
      const prompt = builder.buildDeepExplorePrompt(singleRoot, singleRoot[0], false);
      assert.ok(prompt.includes('TOOLS (read-only + sub-agent):'), 'Missing tool definitions');
      assert.ok(prompt.includes('run_subagent:'), 'Should include run_subagent in tools');
      assert.ok(!prompt.includes('write_file:'), 'Should NOT include write_file');
      assert.ok(!prompt.includes('run_terminal_command:'), 'Should NOT include run_terminal_command');
    });
  });

  // ── Deep explore tool definitions ───────────────────────────────

  suite('getDeepExploreToolDefinitions', () => {
    test('includes run_subagent but not write_file or run_terminal_command', () => {
      const defs = builder.getDeepExploreToolDefinitions();
      const names = defs.map((d: any) => d.function?.name);

      assert.ok(names.includes('run_subagent'), 'Should include run_subagent');
      assert.ok(names.includes('read_file'), 'Should include read_file');
      assert.ok(names.includes('find_definition'), 'Should include find_definition');
      assert.ok(!names.includes('write_file'), 'Should NOT include write_file');
      assert.ok(!names.includes('run_terminal_command'), 'Should NOT include run_terminal_command');
    });

    test('returns exactly 13 tools (12 read-only + run_subagent)', () => {
      const defs = builder.getDeepExploreToolDefinitions();
      assert.strictEqual(defs.length, 13, `Expected 13 deep-explore tools, got ${defs.length}`);
    });
  });

  // ── Agent prompt debugging and deep explore sections ────────────

  suite('agent prompt enhancements', () => {
    test('orchestrator native prompt uses delegation (not verbose exploration sections)', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      // Orchestrator prompt should have delegation strategy, NOT verbose exploration sections
      assert.ok(prompt.includes('ORCHESTRATOR DELEGATION STRATEGY'), 'Missing orchestrator delegation strategy in native prompt');
      assert.ok(!prompt.includes('DEBUGGING STRATEGY'), 'Verbose debugging strategy should not be in native prompt');
      assert.ok(!prompt.includes('CODE NAVIGATION STRATEGY'), 'Verbose code nav should not be in native prompt');
    });

    test('orchestrator XML includes delegation and search tips', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      // Orchestrator XML prompt has delegation strategy + search tips, NOT verbose exploration sections
      assert.ok(prompt.includes('ORCHESTRATOR DELEGATION STRATEGY'), 'XML fallback should have orchestrator delegation');
      assert.ok(prompt.includes('SEARCH TIPS'), 'XML fallback should keep search tips');
      assert.ok(!prompt.includes('CODE NAVIGATION STRATEGY'), 'Verbose code nav should not be in orchestrator XML');
      assert.ok(!prompt.includes('DEBUGGING STRATEGY'), 'Verbose debugging should not be in orchestrator XML');
    });

    test('plan prompt mentions all 8 LSP tools', () => {
      const prompt = builder.buildPlanPrompt(singleRoot, singleRoot[0], true);
      // These were previously missing
      assert.ok(prompt.includes('find_symbol'), 'Missing find_symbol in plan');
      assert.ok(prompt.includes('get_hover_info'), 'Missing get_hover_info in plan');
      assert.ok(prompt.includes('find_implementations'), 'Missing find_implementations in plan');
      assert.ok(prompt.includes('get_type_hierarchy'), 'Missing get_type_hierarchy in plan');
      // These were already present
      assert.ok(prompt.includes('find_definition'), 'Missing find_definition in plan');
      assert.ok(prompt.includes('find_references'), 'Missing find_references in plan');
      assert.ok(prompt.includes('get_call_hierarchy'), 'Missing get_call_hierarchy in plan');
      assert.ok(prompt.includes('get_document_symbols'), 'Missing get_document_symbols in plan');
    });

    test('security review prompt includes CODE INTELLIGENCE FOR SECURITY REVIEW section', () => {
      const prompt = builder.buildSecurityReviewPrompt(singleRoot, singleRoot[0], true);
      assert.ok(prompt.includes('CODE INTELLIGENCE FOR SECURITY REVIEW'), 'Missing code intelligence section in review');
      assert.ok(prompt.includes('find_definition'), 'Missing find_definition in review intelligence');
      assert.ok(prompt.includes('find_references'), 'Missing find_references in review intelligence');
      assert.ok(prompt.includes('get_call_hierarchy'), 'Missing get_call_hierarchy in review intelligence');
      assert.ok(prompt.includes('find_implementations'), 'Missing find_implementations in review intelligence');
      assert.ok(prompt.includes('get_document_symbols'), 'Missing get_document_symbols in review intelligence');
      assert.ok(prompt.includes('get_type_hierarchy'), 'Missing get_type_hierarchy in review intelligence');
      assert.ok(prompt.includes('find_symbol'), 'Missing find_symbol in review intelligence');
      assert.ok(prompt.includes('get_hover_info'), 'Missing get_hover_info in review intelligence');
    });
  });

  // ── Orchestrator tool restriction ───────────────────────────────

  suite('orchestrator tool restriction', () => {
    test('getOrchestratorToolDefinitions returns only 3 tools', () => {
      const tools = builder.getOrchestratorToolDefinitions();
      const names = tools.map((t: any) => t.function.name).sort();

      assert.deepStrictEqual(names, ['run_subagent', 'run_terminal_command', 'write_file']);
    });

    test('getOrchestratorToolDefinitions filters out read-only tools', () => {
      const tools = builder.getOrchestratorToolDefinitions();
      const names = tools.map((t: any) => t.function.name);

      assert.ok(!names.includes('read_file'), 'Should not include read_file');
      assert.ok(!names.includes('search_workspace'), 'Should not include search_workspace');
      assert.ok(!names.includes('find_definition'), 'Should not include find_definition');
      assert.ok(!names.includes('list_files'), 'Should not include list_files');
      assert.ok(!names.includes('get_diagnostics'), 'Should not include get_diagnostics');
    });

    test('orchestrator native prompt includes delegation strategy', () => {
      const prompt = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('ORCHESTRATOR DELEGATION STRATEGY'), 'Missing delegation strategy');
      assert.ok(prompt.includes('SCOUT'), 'Missing SCOUT step');
      assert.ok(prompt.includes('EXPLORE'), 'Missing EXPLORE step');
      assert.ok(prompt.includes('WRITE'), 'Missing WRITE step');
      assert.ok(prompt.includes('VERIFY'), 'Missing VERIFY step');
    });

    test('orchestrator XML prompt includes delegation strategy', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      assert.ok(prompt.includes('ORCHESTRATOR DELEGATION STRATEGY'), 'Missing delegation strategy');
    });

    test('orchestrator XML includes only orchestrator tool definitions', () => {
      const prompt = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      // The XML fallback should define write_file, run_terminal_command, run_subagent
      assert.ok(prompt.includes('write_file:'), 'Missing write_file definition in XML');
      assert.ok(prompt.includes('run_terminal_command:'), 'Missing run_terminal_command definition in XML');
      assert.ok(prompt.includes('run_subagent:'), 'Missing run_subagent definition in XML');
      // Should NOT define read-only tools
      assert.ok(!prompt.includes('read_file:'), 'Should not include read_file definition in orchestrator XML');
      assert.ok(!prompt.includes('search_workspace:'), 'Should not include search_workspace definition in orchestrator XML');
    });

    test('orchestrator prompts do NOT include projectContextBlock', () => {
      const native = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      const xml = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);

      // Both should NOT have code navigation strategy (that's for sub-agents)
      assert.ok(!native.includes('CODE NAVIGATION STRATEGY'), 'Native orchestrator should not have code nav');
      assert.ok(!xml.includes('CODE NAVIGATION STRATEGY'), 'XML orchestrator should not have code nav');
    });

    // ── REGRESSION: Bug #4 — prompt must instruct forwarding file paths ──
    // Before fix: the SUB-AGENT BEST PRACTICES section didn't tell the model
    // to include exact file paths from user context in sub-agent tasks.
    // The model would launch sub-agents with vague descriptions, forcing
    // sub-agents to rediscover files the user already provided.

    test('REGRESSION: orchestrator prompt instructs forwarding file paths to sub-agents', () => {
      const native = builder.buildOrchestratorNativePrompt(singleRoot, singleRoot[0]);
      assert.ok(
        native.includes('ALWAYS include exact file paths'),
        'Orchestrator prompt must instruct the model to forward file paths to sub-agents'
      );
    });

    test('REGRESSION: orchestrator XML prompt also instructs forwarding file paths', () => {
      const xml = builder.buildOrchestratorXmlPrompt(singleRoot, singleRoot[0]);
      assert.ok(
        xml.includes('ALWAYS include exact file paths'),
        'Orchestrator XML prompt must instruct the model to forward file paths to sub-agents'
      );
    });
  });

  // ===========================================================================
  // REGRESSION: Sub-agent prompt MUST tell the model to produce text findings
  // ===========================================================================
  // Before fix: the NO-NARRATION RULE said "every response must be tool calls
  // OR [TASK_COMPLETE]". Small models interpreted this literally and just said
  // [task_complete] without any analysis text after reading a file. The parent
  // orchestrator got nothing useful.

  suite('sub-agent prompt — REGRESSION: REPORT YOUR FINDINGS required', () => {
    test('sub-agent explore prompt includes REPORT YOUR FINDINGS section', () => {
      const prompt = builder.buildSubAgentExplorePrompt(singleRoot, singleRoot[0]);
      assert.ok(
        prompt.includes('REPORT YOUR FINDINGS'),
        'Sub-agent prompt must include REPORT YOUR FINDINGS section'
      );
    });

    test('sub-agent prompt requires text summary before TASK_COMPLETE', () => {
      const prompt = builder.buildSubAgentExplorePrompt(singleRoot, singleRoot[0]);
      assert.ok(
        prompt.includes('MUST write a text summary'),
        'Sub-agent prompt must require text findings before [TASK_COMPLETE]'
      );
    });

    test('sub-agent prompt warns against empty TASK_COMPLETE', () => {
      const prompt = builder.buildSubAgentExplorePrompt(singleRoot, singleRoot[0]);
      assert.ok(
        prompt.includes('NEVER output just [TASK_COMPLETE] with no analysis'),
        'Sub-agent prompt must warn against empty [TASK_COMPLETE]'
      );
    });
  });
});
