import * as assert from 'assert';
import {
  getProgressGroupTitle,
  getToolActionInfo,
  getToolSuccessInfo
} from '../../../../src/views/toolUIFormatter';

suite('toolUIFormatter', () => {

  // ─── getProgressGroupTitle ─────────────────────────────────────────

  suite('getProgressGroupTitle', () => {

    test('single read_file shows filename', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { path: 'src/utils/helpers.ts' } }
      ]);
      assert.strictEqual(title, 'Reading helpers.ts');
    });

    test('multiple read_file calls show comma-separated filenames', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { path: 'src/a.ts' } },
        { name: 'read_file', args: { path: 'src/b.ts' } },
        { name: 'read_file', args: { path: 'src/c.ts' } }
      ]);
      assert.strictEqual(title, 'Reading a.ts, b.ts, c.ts');
    });

    test('more than 5 read_file calls shows count with overflow', () => {
      const calls = Array.from({ length: 6 }, (_, i) => ({
        name: 'read_file',
        args: { path: `file${i}.ts` }
      }));
      const title = getProgressGroupTitle(calls);
      assert.ok(title.startsWith('Reading '), 'Should start with Reading');
      assert.ok(title.includes('(+'), 'Should show overflow count');
    });

    test('duplicate read paths are deduplicated', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { path: 'README.md' } },
        { name: 'read_file', args: { path: 'README.md' } }
      ]);
      assert.strictEqual(title, 'Reading README.md');
    });

    test('read_file with "file" arg variant extracts filename', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { file: 'docs/guide.md' } }
      ]);
      assert.strictEqual(title, 'Reading guide.md');
    });

    test('read + write returns "Editing <filename>"', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'write_file', args: { path: 'b.ts' } }
      ]);
      assert.strictEqual(title, 'Editing b.ts');
    });

    test('search returns "Searching codebase"', () => {
      const title = getProgressGroupTitle([
        { name: 'search_workspace', args: { query: 'foo' } }
      ]);
      assert.strictEqual(title, 'Searching codebase');
    });

    test('find_symbol returns "Searching codebase"', () => {
      const title = getProgressGroupTitle([
        { name: 'find_symbol', args: { query: 'MyClass' } }
      ]);
      assert.strictEqual(title, 'Searching codebase');
    });

    test('find_definition returns "Analyzing code structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'find_definition', args: { path: 'a.ts', symbolName: 'foo' } }
      ]);
      assert.strictEqual(title, 'Analyzing code structure');
    });

    test('find_references returns "Analyzing code structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'find_references', args: { path: 'a.ts', symbolName: 'foo' } }
      ]);
      assert.strictEqual(title, 'Analyzing code structure');
    });

    test('get_hover_info returns "Analyzing code structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'get_hover_info', args: { path: 'a.ts', symbolName: 'x' } }
      ]);
      assert.strictEqual(title, 'Analyzing code structure');
    });

    test('get_call_hierarchy returns "Analyzing code structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'get_call_hierarchy', args: { path: 'a.ts', symbolName: 'foo' } }
      ]);
      assert.strictEqual(title, 'Analyzing code structure');
    });

    test('find_implementations returns "Analyzing code structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'find_implementations', args: { path: 'a.ts', symbolName: 'IFoo' } }
      ]);
      assert.strictEqual(title, 'Analyzing code structure');
    });

    test('get_type_hierarchy returns "Analyzing code structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'get_type_hierarchy', args: { path: 'a.ts', symbolName: 'Foo' } }
      ]);
      assert.strictEqual(title, 'Analyzing code structure');
    });

    test('get_document_symbols alone returns "Inspecting file structure"', () => {
      const title = getProgressGroupTitle([
        { name: 'get_document_symbols', args: { path: 'a.ts' } }
      ]);
      assert.strictEqual(title, 'Inspecting file structure');
    });

    test('write only returns "Writing <filename>"', () => {
      const title = getProgressGroupTitle([
        { name: 'write_file', args: { path: 'a.ts' } }
      ]);
      assert.strictEqual(title, 'Writing a.ts');
    });

    test('list_files only returns "Exploring workspace"', () => {
      const title = getProgressGroupTitle([
        { name: 'list_files', args: { path: '.' } }
      ]);
      assert.strictEqual(title, 'Exploring workspace');
    });

    test('read + list_files falls through to "Reading files"', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'list_files', args: { path: '.' } }
      ]);
      assert.strictEqual(title, 'Reading files');
    });

    test('command only returns "Running commands"', () => {
      const title = getProgressGroupTitle([
        { name: 'run_terminal_command', args: { command: 'ls' } }
      ]);
      assert.strictEqual(title, 'Running commands');
    });

    test('empty args fallback returns "Reading files" for read with no path', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: {} }
      ]);
      assert.strictEqual(title, 'Reading files');
    });

    test('run_subagent returns "Delegating subtask"', () => {
      const title = getProgressGroupTitle([
        { name: 'run_subagent', args: { task: 'check tests' } }
      ]);
      assert.strictEqual(title, 'Delegating subtask');
    });

    test('get_diagnostics alone returns "Checking diagnostics"', () => {
      const title = getProgressGroupTitle([
        { name: 'get_diagnostics', args: { path: 'src/main.ts' } }
      ]);
      assert.strictEqual(title, 'Checking diagnostics');
    });

    test('navigation + search returns "Tracing code paths"', () => {
      const title = getProgressGroupTitle([
        { name: 'find_references', args: { path: 'a.ts', symbolName: 'foo' } },
        { name: 'search_workspace', args: { query: 'bar' } }
      ]);
      assert.strictEqual(title, 'Tracing code paths');
    });

    test('search + read returns "Searching and reading code"', () => {
      const title = getProgressGroupTitle([
        { name: 'search_workspace', args: { query: 'foo' } },
        { name: 'read_file', args: { path: 'a.ts' } }
      ]);
      assert.strictEqual(title, 'Searching and reading code');
    });

    test('write with no path falls back to "Writing files"', () => {
      const title = getProgressGroupTitle([
        { name: 'write_file', args: {} }
      ]);
      assert.strictEqual(title, 'Writing files');
    });
  });

  // ─── getToolActionInfo ─────────────────────────────────────────────

  suite('getToolActionInfo', () => {

    test('read_file shows "Reading <filename>"', () => {
      const info = getToolActionInfo('read_file', { path: 'src/main.ts' });
      assert.strictEqual(info.actionText, 'Reading main.ts');
      assert.strictEqual(info.actionIcon, '📄');
    });

    test('read_file with startLine shows line range in detail', () => {
      const info = getToolActionInfo('read_file', { path: 'a.ts', startLine: 1, endLine: 100 });
      assert.strictEqual(info.actionDetail, 'lines 1–100');
    });

    test('read_file without startLine has empty detail', () => {
      const info = getToolActionInfo('read_file', { path: 'a.ts' });
      assert.strictEqual(info.actionDetail, '');
    });

    test('write_file shows "Write <filename>"', () => {
      const info = getToolActionInfo('write_file', { path: 'x.ts' });
      assert.strictEqual(info.actionText, 'Write x.ts');
    });

    test('list_files shows "List <path>"', () => {
      const info = getToolActionInfo('list_files', { path: 'src' });
      assert.strictEqual(info.actionText, 'List src');
    });

    test('search_workspace shows query', () => {
      const info = getToolActionInfo('search_workspace', { query: 'TODO' });
      assert.strictEqual(info.actionText, 'Search for "TODO"');
    });

    test('unknown tool returns tool name', () => {
      const info = getToolActionInfo('custom_tool', {});
      assert.strictEqual(info.actionText, 'custom_tool');
    });

    test('get_document_symbols shows "Symbols in <file>"', () => {
      const info = getToolActionInfo('get_document_symbols', { path: 'src/main.ts' });
      assert.strictEqual(info.actionText, 'Symbols in main.ts');
      assert.strictEqual(info.actionIcon, '🏗️');
    });

    test('find_definition shows symbol name', () => {
      const info = getToolActionInfo('find_definition', { path: 'a.ts', symbolName: 'handleRequest' });
      assert.strictEqual(info.actionText, 'Definition of handleRequest');
      assert.strictEqual(info.actionIcon, '🎯');
    });

    test('find_references shows symbol name', () => {
      const info = getToolActionInfo('find_references', { path: 'a.ts', symbolName: 'Config' });
      assert.strictEqual(info.actionText, 'References to Config');
      assert.strictEqual(info.actionIcon, '🔗');
    });

    test('find_symbol shows query', () => {
      const info = getToolActionInfo('find_symbol', { query: 'ChatView' });
      assert.strictEqual(info.actionText, 'Find symbol "ChatView"');
      assert.strictEqual(info.actionIcon, '🔍');
    });

    test('get_hover_info shows symbol name', () => {
      const info = getToolActionInfo('get_hover_info', { path: 'a.ts', symbolName: 'myVar' });
      assert.strictEqual(info.actionText, 'Type info for myVar');
      assert.strictEqual(info.actionIcon, '📝');
    });

    test('get_call_hierarchy shows symbol name and direction', () => {
      const info = getToolActionInfo('get_call_hierarchy', { path: 'a.ts', symbolName: 'run', direction: 'outgoing' });
      assert.strictEqual(info.actionText, 'Call hierarchy of run');
      assert.strictEqual(info.actionDetail, 'outgoing');
      assert.strictEqual(info.actionIcon, '🌳');
    });

    test('find_implementations shows symbol name', () => {
      const info = getToolActionInfo('find_implementations', { path: 'a.ts', symbolName: 'IHandler' });
      assert.strictEqual(info.actionText, 'Implementations of IHandler');
      assert.strictEqual(info.actionIcon, '🧩');
    });

    test('get_type_hierarchy shows symbol name and direction', () => {
      const info = getToolActionInfo('get_type_hierarchy', { path: 'a.ts', symbolName: 'MyClass', direction: 'subtypes' });
      assert.strictEqual(info.actionText, 'Type hierarchy of MyClass');
      assert.strictEqual(info.actionDetail, 'subtypes');
      assert.strictEqual(info.actionIcon, '🏛️');
    });
  });

  // ─── getToolSuccessInfo ────────────────────────────────────────────

  suite('getToolSuccessInfo', () => {

    test('read_file returns filePath and line count', () => {
      const info = getToolSuccessInfo('read_file', { path: 'src/a.ts' }, 'line1\nline2\nline3');
      assert.strictEqual(info.actionText, 'Read a.ts');
      assert.strictEqual(info.filePath, 'src/a.ts');
      assert.ok(info.actionDetail.includes('3 lines'));
    });

    test('read_file with startLine returns range detail and startLine', () => {
      const info = getToolSuccessInfo(
        'read_file',
        { path: 'b.ts', startLine: 10, endLine: 20 },
        'content here'
      );
      assert.strictEqual(info.startLine, 10);
      assert.ok(info.actionDetail.includes('lines 10–20'));
    });

    test('read_file without startLine omits startLine from result', () => {
      const info = getToolSuccessInfo('read_file', { path: 'c.ts' }, 'stuff');
      assert.strictEqual(info.startLine, undefined);
    });

    test('write_file returns filePath', () => {
      const info = getToolSuccessInfo('write_file', { path: 'd.ts' }, '');
      assert.strictEqual(info.filePath, 'd.ts');
      assert.strictEqual(info.actionText, 'Edited d.ts');
    });

    test('write_file with _isNew=true returns "Created" verb', () => {
      const info = getToolSuccessInfo('write_file', { path: 'newFile.ts', _isNew: true }, '');
      assert.strictEqual(info.actionText, 'Created newFile.ts');
      assert.strictEqual(info.filePath, 'newFile.ts');
    });

    test('write_file with _isNew=false returns "Edited" verb', () => {
      const info = getToolSuccessInfo('write_file', { path: 'existing.ts', _isNew: false }, '');
      assert.strictEqual(info.actionText, 'Edited existing.ts');
    });

    test('write_file without _isNew defaults to "Edited" verb', () => {
      const info = getToolSuccessInfo('write_file', { path: 'foo.ts' }, '');
      assert.strictEqual(info.actionText, 'Edited foo.ts');
    });

    test('create_file returns "Created" verb', () => {
      const info = getToolSuccessInfo('create_file', { path: 'brand-new.ts' }, '');
      assert.strictEqual(info.actionText, 'Created brand-new.ts');
    });

    test('list_files includes basePath tab-separated in detail', () => {
      const output = '📁 src\n📄 readme.md\t1234';
      const info = getToolSuccessInfo('list_files', { path: 'mydir' }, output);
      assert.strictEqual(info.actionText, 'Listed mydir');
      // Detail format: "summary\tbasePath\nlistings"
      assert.ok(info.actionDetail.includes('\tmydir\n'), 'basePath should be tab-separated');
      assert.ok(info.actionDetail.includes('📁 src'));
      assert.ok(info.actionDetail.includes('📄 readme.md'));
    });

    test('list_files in workspace root uses empty basePath', () => {
      const output = '📁 dir1';
      const info = getToolSuccessInfo('list_files', { path: '' }, output);
      assert.ok(info.actionDetail.includes('\t\n') || info.actionDetail.includes('\t'), 'empty basePath');
    });

    test('search_workspace reports match count', () => {
      const output = [
        'Found 3 matches across 2 files:',
        '',
        '── src/app.ts ──',
        '  1: import express',
        '→ 2: const foo = "bar";',
        '  3: app.listen()',
        '',
        '── src/util.ts ──',
        '→ 5: function foo() {',
        '  6:   return 1;',
        '',
        '→ 10: export const foo = 42;',
      ].join('\n');
      const info = getToolSuccessInfo('search_workspace', { query: 'foo' }, output);
      assert.ok(info.actionText.includes('3 match'), 'actionText should count actual matches');
      assert.ok(info.actionText.includes('"foo"'), 'actionText should include query');
      assert.ok(info.actionDetail.includes('2 file'), 'actionDetail summary should show file count');
      assert.ok(info.actionDetail.includes('📄'), 'actionDetail should have file listing entries');
      assert.ok(info.actionDetail.includes('src/app.ts'), 'listing should include first file path');
      assert.ok(info.actionDetail.includes('src/util.ts'), 'listing should include second file path');
    });

    test('search_workspace with no matches', () => {
      const output = 'No matches found for "xyz"';
      const info = getToolSuccessInfo('search_workspace', { query: 'xyz' }, output);
      assert.ok(info.actionText.includes('No matches'), 'should report no matches');
      assert.strictEqual(info.actionDetail, '');
    });

    test('run_terminal_command reports exit code', () => {
      const info = getToolSuccessInfo('run_terminal_command', { command: 'ls -la' }, 'Exit code: 0');
      assert.strictEqual(info.actionText, 'Command completed');
      assert.ok(info.actionDetail.includes('exit 0'));
    });

    test('find_definition success reports found', () => {
      const info = getToolSuccessInfo('find_definition', { symbolName: 'greet' }, 'Definition:\n\nsample.ts:6');
      assert.strictEqual(info.actionText, 'Found definition');
    });

    test('find_definition no result reports not found', () => {
      const info = getToolSuccessInfo('find_definition', { symbolName: 'greet' }, 'No definition found for greet.');
      assert.strictEqual(info.actionText, 'No definition found');
    });

    test('find_references success reports count', () => {
      const info = getToolSuccessInfo('find_references', { symbolName: 'greet' }, 'Found 3 references across 2 files:');
      assert.strictEqual(info.actionText, 'Found 3 references');
    });

    test('find_symbol success reports count', () => {
      const info = getToolSuccessInfo('find_symbol', { query: 'Service' }, 'Found 2 symbols matching "Service":');
      assert.strictEqual(info.actionText, 'Found 2 symbols');
    });

    test('get_hover_info success reports got type info', () => {
      const info = getToolSuccessInfo('get_hover_info', { symbolName: 'x' }, 'Hover info for x:\n\n(variable) x: number');
      assert.strictEqual(info.actionText, 'Got type info');
    });

    test('get_hover_info no result reports unavailable', () => {
      const info = getToolSuccessInfo('get_hover_info', { symbolName: 'x' }, 'No hover information available for x.');
      assert.strictEqual(info.actionText, 'No type info available');
    });

    test('get_call_hierarchy success reports found', () => {
      const info = getToolSuccessInfo('get_call_hierarchy', { symbolName: 'run' }, 'Call hierarchy for Method run:');
      assert.strictEqual(info.actionText, 'Got call hierarchy');
    });

    test('get_document_symbols success reports count', () => {
      const output = 'Symbols in sample.ts:\nFunction greet (L6)\nClass Service (L14-L24)';
      const info = getToolSuccessInfo('get_document_symbols', { path: 'sample.ts' }, output);
      assert.ok(info.actionText.includes('symbol'), 'Should mention symbols');
    });

    test('find_implementations success reports count', () => {
      const info = getToolSuccessInfo('find_implementations', { symbolName: 'IHandler' }, '3 implementations:');
      assert.strictEqual(info.actionText, 'Found 3 implementations');
    });

    test('find_implementations no result reports zero', () => {
      const info = getToolSuccessInfo('find_implementations', { symbolName: 'IHandler' }, 'No implementations found for IHandler.');
      assert.strictEqual(info.actionText, 'Found 0 implementations');
    });

    test('get_type_hierarchy success reports found', () => {
      const info = getToolSuccessInfo('get_type_hierarchy', { symbolName: 'MyClass' }, 'Type hierarchy for Class MyClass:');
      assert.strictEqual(info.actionText, 'Got type hierarchy');
    });

    test('get_type_hierarchy no result reports unavailable', () => {
      const info = getToolSuccessInfo('get_type_hierarchy', { symbolName: 'X' }, 'No type hierarchy available for X.');
      assert.strictEqual(info.actionText, 'No type hierarchy available');
    });

    test('run_subagent success shows completed message', () => {
      const info = getToolSuccessInfo('run_subagent', { task: 'Find bugs', mode: 'review' }, 'Found 3 potential issues');
      assert.ok(info.actionText.includes('completed'));
    });
  });

  // ─── run_subagent in getToolActionInfo ─────────────────────────────

  suite('run_subagent action info', () => {
    test('run_subagent action shows rocket icon', () => {
      const info = getToolActionInfo('run_subagent', { task: 'Search for patterns', mode: 'explore' });
      assert.strictEqual(info.actionIcon, '🤖');
      assert.strictEqual(info.actionText, 'Search for patterns');
    });

    test('run_subagent review mode shows review detail', () => {
      const info = getToolActionInfo('run_subagent', { task: 'Check security', mode: 'review' });
      assert.ok(info.actionDetail.toLowerCase().includes('review'));
    });

    test('run_subagent explore mode shows explore detail', () => {
      const info = getToolActionInfo('run_subagent', { task: 'Find files', mode: 'explore' });
      assert.ok(info.actionDetail.toLowerCase().includes('explore'));
    });
  });
});
