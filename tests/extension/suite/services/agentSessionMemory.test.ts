import * as assert from 'assert';
import { AgentSessionMemory, IterationSummary } from '../../../../src/services/agent/agentSessionMemory';

/**
 * Tests for AgentSessionMemory — structured in-memory notes maintained
 * across agent iterations.
 */

// ─── Stub helpers ────────────────────────────────────────────────────

function createStubOutputChannel(): any {
  return {
    appendLine: () => {},
    append: () => {},
    show: () => {},
    dispose: () => {}
  };
}

function makeSummary(overrides: Partial<IterationSummary> = {}): IterationSummary {
  return {
    iteration: 1,
    toolsCalled: [],
    filesRead: [],
    filesWritten: [],
    errorsEncountered: [],
    keyFindings: [],
    ...overrides
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('AgentSessionMemory', () => {
  let memory: AgentSessionMemory;

  setup(() => {
    memory = new AgentSessionMemory(createStubOutputChannel());
  });

  // ── Basic CRUD ──────────────────────────────────────────────────

  test('set/get round-trip', () => {
    memory.set('key1', 'value1');
    assert.strictEqual(memory.get('key1'), 'value1');
  });

  test('get returns undefined for missing key', () => {
    assert.strictEqual(memory.get('nonexistent'), undefined);
  });

  test('set overwrites existing entry', () => {
    memory.set('key1', 'old');
    memory.set('key1', 'new');
    assert.strictEqual(memory.get('key1'), 'new');
  });

  // ── Iteration tracking ──────────────────────────────────────────

  test('addIterationSummary increments iterationCount', () => {
    assert.strictEqual(memory.iterationCount, 0);
    memory.addIterationSummary(makeSummary({ iteration: 1 }));
    assert.strictEqual(memory.iterationCount, 1);
    memory.addIterationSummary(makeSummary({ iteration: 2 }));
    assert.strictEqual(memory.iterationCount, 2);
  });

  // ── User preferences ───────────────────────────────────────────

  test('addUserPreference deduplicates', () => {
    memory.addUserPreference('Use TypeScript');
    memory.addUserPreference('Use TypeScript');
    memory.addUserPreference('Prefer tabs');

    // Trigger toSystemReminder to check preferences are included
    memory.addIterationSummary(makeSummary()); // ensure non-empty
    const reminder = memory.toSystemReminder();
    // Count occurrences of 'Use TypeScript' — should be exactly 1
    const matches = reminder.match(/Use TypeScript/g);
    assert.strictEqual(matches?.length, 1, 'Preference should appear exactly once');
    assert.ok(reminder.includes('Prefer tabs'), 'Second preference should be present');
  });

  // ── toSystemReminder ───────────────────────────────────────────

  test('toSystemReminder returns empty string when no entries/iterations', () => {
    const result = memory.toSystemReminder();
    assert.strictEqual(result, '', 'Should return empty string when empty');
  });

  test('toSystemReminder includes session_memory wrapper', () => {
    memory.set('project_type', 'TypeScript');
    const result = memory.toSystemReminder();
    assert.ok(result.includes('<session_memory>'), 'Should have opening tag');
    assert.ok(result.includes('</session_memory>'), 'Should have closing tag');
  });

  test('toSystemReminder includes Session Notes section', () => {
    memory.set('project_type', 'TypeScript');
    memory.set('entry_point', 'src/main.ts');
    const result = memory.toSystemReminder();
    assert.ok(result.includes('## Session Notes'), 'Should include Session Notes header');
    assert.ok(result.includes('project_type'), 'Should include key name');
    assert.ok(result.includes('TypeScript'), 'Should include key value');
  });

  test('toSystemReminder includes Recent Activity (last 3 iterations)', () => {
    for (let i = 1; i <= 5; i++) {
      memory.addIterationSummary(makeSummary({
        iteration: i,
        filesRead: [`file${i}.ts`]
      }));
    }
    const result = memory.toSystemReminder();
    assert.ok(result.includes('## Recent Activity'), 'Should include Recent Activity');

    // Only last 3 should appear
    assert.ok(!result.includes('Iter 1:'), 'Iter 1 should not appear (only last 3)');
    assert.ok(!result.includes('Iter 2:'), 'Iter 2 should not appear');
    assert.ok(result.includes('Iter 3:'), 'Iter 3 should appear');
    assert.ok(result.includes('Iter 4:'), 'Iter 4 should appear');
    assert.ok(result.includes('Iter 5:'), 'Iter 5 should appear');
  });

  test('toSystemReminder includes File Tracking section', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      filesRead: ['src/main.ts', 'src/utils.ts'],
      filesWritten: ['src/output.ts']
    }));
    const result = memory.toSystemReminder();
    assert.ok(result.includes('## File Tracking'), 'Should include File Tracking');
    assert.ok(result.includes('Files explored:'), 'Should show files explored');
    assert.ok(result.includes('Files modified:'), 'Should show files modified');
    assert.ok(result.includes('src/main.ts'), 'Should list read file');
    assert.ok(result.includes('src/output.ts'), 'Should list written file');
  });

  test('toSystemReminder caps file list to 15 with "+N more"', () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      filesRead: manyFiles
    }));
    const result = memory.toSystemReminder();
    assert.ok(result.includes('+5 more'), 'Should show +5 more for 20 files with 15 cap');
  });

  test('toSystemReminder includes User Preferences section', () => {
    memory.addUserPreference('Use ESLint');
    memory.set('something', 'value'); // need at least one entry for non-empty result
    const result = memory.toSystemReminder();
    assert.ok(result.includes('## User Preferences'), 'Should have preferences section');
    assert.ok(result.includes('Use ESLint'), 'Should list the preference');
  });

  // ── autoExtractEntries (tested via addIterationSummary) ──────────

  test('auto-extracts project_config_files from read files', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      filesRead: ['package.json', 'tsconfig.json', 'src/main.ts']
    }));
    const configFiles = memory.get('project_config_files');
    assert.ok(configFiles, 'Should have project_config_files entry');
    assert.ok(configFiles.includes('package.json'), 'Should include package.json');
    assert.ok(configFiles.includes('tsconfig.json'), 'Should include tsconfig.json');
    assert.ok(!configFiles.includes('src/main.ts'), 'Should NOT include non-config file');
  });

  test('auto-increments total_errors on failed tools', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      errorsEncountered: ['read_file: ENOENT', 'write_file: Permission denied']
    }));
    assert.strictEqual(memory.get('total_errors'), '2');

    memory.addIterationSummary(makeSummary({
      iteration: 2,
      errorsEncountered: ['search: timeout']
    }));
    assert.strictEqual(memory.get('total_errors'), '3');
  });

  test('auto-tracks files_modified from written files', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      filesWritten: ['src/app.ts']
    }));
    assert.ok(memory.get('files_modified')?.includes('src/app.ts'));

    memory.addIterationSummary(makeSummary({
      iteration: 2,
      filesWritten: ['src/app.ts', 'src/utils.ts'] // app.ts again — should dedupe
    }));
    const modified = memory.get('files_modified')!;
    assert.ok(modified.includes('src/app.ts'), 'Should include app.ts');
    assert.ok(modified.includes('src/utils.ts'), 'Should include utils.ts');
    // Count occurrences of app.ts
    const appCount = modified.split('src/app.ts').length - 1;
    assert.strictEqual(appCount, 1, 'app.ts should appear only once (dedup)');
  });

  // ── buildIterationSummary (static) ──────────────────────────────

  test('buildIterationSummary categorizes tool results', () => {
    const toolResults = [
      { name: 'read_file', args: { path: 'src/main.ts' }, output: 'file content', success: true },
      { name: 'write_file', args: { path: 'src/output.ts' }, output: 'written', success: true },
      { name: 'search_workspace', args: { query: 'TODO' }, output: 'match1\nmatch2\nmatch3\nmatch4\nmatch5', success: true },
      { name: 'run_terminal_command', args: { command: 'npm test' }, output: '', success: false },
    ];

    const summary = AgentSessionMemory.buildIterationSummary(3, toolResults);

    assert.strictEqual(summary.iteration, 3);
    assert.deepStrictEqual(summary.toolsCalled, ['read_file', 'write_file', 'search_workspace', 'run_terminal_command']);
    assert.deepStrictEqual(summary.filesRead, ['src/main.ts']);
    assert.deepStrictEqual(summary.filesWritten, ['src/output.ts']);
    assert.strictEqual(summary.errorsEncountered.length, 1, 'Should have 1 error');
    assert.ok(summary.errorsEncountered[0].includes('run_terminal_command'), 'Error should name the tool');
    assert.strictEqual(summary.keyFindings.length, 1, 'Should have 1 finding from search');
    assert.ok(summary.keyFindings[0].includes('4 matches'), 'Should count search matches (newlines)');
  });

  test('buildIterationSummary handles empty results', () => {
    const summary = AgentSessionMemory.buildIterationSummary(1, []);
    assert.strictEqual(summary.iteration, 1);
    assert.strictEqual(summary.toolsCalled.length, 0);
    assert.strictEqual(summary.filesRead.length, 0);
    assert.strictEqual(summary.filesWritten.length, 0);
    assert.strictEqual(summary.errorsEncountered.length, 0);
    assert.strictEqual(summary.keyFindings.length, 0);
  });

  // ── getCompactSummary ───────────────────────────────────────────

  test('getCompactSummary returns empty string with no data', () => {
    assert.strictEqual(memory.getCompactSummary(), '');
  });

  test('getCompactSummary includes file counts', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      filesRead: ['a.ts', 'b.ts'],
      filesWritten: ['c.ts']
    }));
    const summary = memory.getCompactSummary();
    assert.ok(summary.includes('2 files read'), 'Should show read count');
    assert.ok(summary.includes('1 files written'), 'Should show write count');
  });

  test('getCompactSummary includes error count', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      errorsEncountered: ['error1', 'error2']
    }));
    const summary = memory.getCompactSummary();
    assert.ok(summary.includes('2 errors encountered'), 'Should show error count');
  });

  test('getCompactSummary includes preference count', () => {
    memory.addUserPreference('pref1');
    memory.addUserPreference('pref2');
    memory.addIterationSummary(makeSummary({ iteration: 1, filesRead: ['a.ts'] }));
    const summary = memory.getCompactSummary();
    assert.ok(summary.includes('2 prefs noted'), 'Should show pref count');
  });

  // ── toJSON / fromJSON serialization ─────────────────────────────

  test('toJSON/fromJSON round-trip preserves entries', () => {
    memory.set('key1', 'value1');
    memory.set('key2', 'value2');
    const json = memory.toJSON();

    const restored = AgentSessionMemory.fromJSON(json, createStubOutputChannel());
    assert.strictEqual(restored.get('key1'), 'value1');
    assert.strictEqual(restored.get('key2'), 'value2');
  });

  test('toJSON/fromJSON round-trip preserves iteration history', () => {
    memory.addIterationSummary(makeSummary({ iteration: 1, filesRead: ['a.ts'] }));
    memory.addIterationSummary(makeSummary({ iteration: 2, filesWritten: ['b.ts'] }));
    const json = memory.toJSON();

    const restored = AgentSessionMemory.fromJSON(json, createStubOutputChannel());
    assert.strictEqual(restored.iterationCount, 2);
  });

  test('toJSON/fromJSON round-trip preserves user preferences', () => {
    memory.addUserPreference('Use tabs');
    memory.set('x', 'y'); // trigger non-empty
    const json = memory.toJSON();

    const restored = AgentSessionMemory.fromJSON(json, createStubOutputChannel());
    const reminder = restored.toSystemReminder();
    assert.ok(reminder.includes('Use tabs'), 'Restored memory should have preference');
  });

  test('fromJSON returns empty memory on invalid JSON', () => {
    const restored = AgentSessionMemory.fromJSON('not valid json', createStubOutputChannel());
    assert.strictEqual(restored.iterationCount, 0);
    assert.strictEqual(restored.getCompactSummary(), '');
  });

  // ── functions_explored tracking ─────────────────────────────────

  test('buildIterationSummary captures code intelligence tool findings', () => {
    const toolResults = [
      { name: 'find_definition', args: { path: 'src/main.ts', symbolName: 'handleRequest' }, output: 'Found at src/handler.ts:42', success: true },
      { name: 'get_call_hierarchy', args: { path: 'src/handler.ts', symbolName: 'processData' }, output: 'Outgoing: saveResult', success: true },
      { name: 'read_file', args: { path: 'src/main.ts' }, output: 'file contents', success: true },
    ];

    const summary = AgentSessionMemory.buildIterationSummary(1, toolResults);

    // Should have key findings from code intelligence tools
    const defFindings = summary.keyFindings.filter(f => f.includes('handleRequest'));
    assert.ok(defFindings.length > 0, 'Should capture find_definition finding for handleRequest');

    const hierarchyFindings = summary.keyFindings.filter(f => f.includes('processData'));
    assert.ok(hierarchyFindings.length > 0, 'Should capture get_call_hierarchy finding for processData');
  });

  test('autoExtractFunctionsExplored populates functions_explored entry', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      toolsCalled: ['find_definition', 'get_call_hierarchy'],
      keyFindings: [
        'find_definition: definition of "handleRequest" found',
        'get_call_hierarchy: definition of "processData" found',
      ]
    }));

    const functionsExplored = memory.get('functions_explored');
    assert.ok(functionsExplored, 'Should have functions_explored entry');
    assert.ok(functionsExplored.includes('handleRequest'), 'Should include handleRequest');
    assert.ok(functionsExplored.includes('processData'), 'Should include processData');
  });

  test('functions_explored deduplicates across iterations', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      toolsCalled: ['find_definition'],
      keyFindings: ['find_definition: definition of "handleRequest" found']
    }));
    memory.addIterationSummary(makeSummary({
      iteration: 2,
      toolsCalled: ['find_definition'],
      keyFindings: ['find_definition: definition of "handleRequest" found']
    }));

    const functionsExplored = memory.get('functions_explored')!;
    const count = functionsExplored.split('handleRequest').length - 1;
    assert.strictEqual(count, 1, 'handleRequest should appear only once (deduplicated)');
  });

  test('getCompactSummary includes functions explored count', () => {
    memory.addIterationSummary(makeSummary({
      iteration: 1,
      toolsCalled: ['find_definition', 'find_references'],
      filesRead: ['a.ts'],
      keyFindings: [
        'find_definition: definition of "funcA" found',
        'find_references: definition of "funcB" found',
      ]
    }));

    const summary = memory.getCompactSummary();
    assert.ok(summary.includes('functions explored'), 'Should show functions explored count');
  });

  // ── originalTask tracking ───────────────────────────────────────

  test('setOriginalTask / getOriginalTask round-trip', () => {
    memory.setOriginalTask('Create a documentation file');
    assert.strictEqual(memory.getOriginalTask(), 'Create a documentation file');
  });

  test('toSystemReminder includes Task Reference as first section (truncated)', () => {
    memory.setOriginalTask('Scan processSearch and document all functions');
    memory.set('project_type', 'TypeScript');
    const result = memory.toSystemReminder();
    assert.ok(result.includes('## Task Reference'), 'Should have Task Reference section');
    assert.ok(result.includes('Scan processSearch'), 'Should include task text (short enough to survive truncation)');
    // Task Reference should appear BEFORE Session Notes
    const taskIdx = result.indexOf('## Task Reference');
    const notesIdx = result.indexOf('## Session Notes');
    assert.ok(taskIdx < notesIdx, 'Task Reference should come before Session Notes');
  });

  test('toSystemReminder truncates long tasks to 120 chars', () => {
    const longTask = 'A'.repeat(200);
    memory.setOriginalTask(longTask);
    memory.set('project_type', 'TypeScript');
    const result = memory.toSystemReminder();
    assert.ok(result.includes('## Task Reference'), 'Should have Task Reference section');
    assert.ok(result.includes('…'), 'Should include ellipsis for truncated task');
    assert.ok(!result.includes('A'.repeat(200)), 'Should NOT include full 200-char task');
  });

  test('toJSON/fromJSON round-trip preserves originalTask', () => {
    memory.setOriginalTask('Fix the login bug');
    memory.set('x', 'y');
    const json = memory.toJSON();

    const restored = AgentSessionMemory.fromJSON(json, createStubOutputChannel());
    assert.strictEqual(restored.getOriginalTask(), 'Fix the login bug');
  });

  test('toSystemReminder omits Task Reference when not set', () => {
    memory.set('project_type', 'TypeScript');
    const result = memory.toSystemReminder();
    assert.ok(!result.includes('## Task Reference'), 'Should not have Task Reference if not set');
  });
});
