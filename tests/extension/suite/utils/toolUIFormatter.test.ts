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

    test('more than 5 read_file calls shows "Reading multiple files"', () => {
      const calls = Array.from({ length: 6 }, (_, i) => ({
        name: 'read_file',
        args: { path: `file${i}.ts` }
      }));
      const title = getProgressGroupTitle(calls);
      assert.strictEqual(title, 'Reading multiple files');
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

    test('read + write returns "Modifying files"', () => {
      const title = getProgressGroupTitle([
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'write_file', args: { path: 'b.ts' } }
      ]);
      assert.strictEqual(title, 'Modifying files');
    });

    test('search returns "Searching codebase"', () => {
      const title = getProgressGroupTitle([
        { name: 'search_workspace', args: { query: 'foo' } }
      ]);
      assert.strictEqual(title, 'Searching codebase');
    });

    test('write only returns "Writing files"', () => {
      const title = getProgressGroupTitle([
        { name: 'write_file', args: { path: 'a.ts' } }
      ]);
      assert.strictEqual(title, 'Writing files');
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
      const output = 'file1.ts\nfile2.ts\nfile3.ts';
      const info = getToolSuccessInfo('search_workspace', { query: 'foo' }, output);
      assert.ok(info.actionText.includes('3 files'));
    });

    test('run_terminal_command reports exit code', () => {
      const info = getToolSuccessInfo('run_terminal_command', { command: 'ls -la' }, 'Exit code: 0');
      assert.strictEqual(info.actionText, 'Command completed');
      assert.ok(info.actionDetail.includes('exit 0'));
    });
  });
});
