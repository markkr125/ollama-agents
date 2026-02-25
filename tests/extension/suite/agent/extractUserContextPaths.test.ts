import * as assert from 'assert';
import { extractUserContextPaths, extractUserContextBlocks, extractSymbolMap } from '../../../../src/agent/execution/orchestration/agentChatExecutor';

/**
 * Tests for extractUserContextPaths — the helper that auto-injects
 * user-provided file paths into sub-agent tasks.
 *
 * Regression context: Sub-agents were getting ENOENT errors because
 * the orchestrator model didn't forward file paths from user context.
 * The sub-agent guessed "src/SearchController.ts" when the real path
 * was "src/controllers/search/SearchController.ts". This wasted 7+
 * iterations searching for a file that was already known.
 */
suite('extractUserContextPaths', () => {

  test('extracts path with line range from selected code marker', () => {
    const prompt =
      'User\'s selected code from search-node-master/src/controllers/search/SearchController.ts:L118-L271 (already provided — do not re-read):\n' +
      '```\nclass SearchController {}\n```\n\nAnalyze this code';
    const paths = extractUserContextPaths(prompt);
    assert.deepStrictEqual(paths, ['search-node-master/src/controllers/search/SearchController.ts']);
  });

  test('extracts path without line range from Contents marker', () => {
    const prompt =
      'Contents of src/utils/helpers.ts (already provided — do not re-read):\n' +
      '```\nexport function foo() {}\n```\n\nExplain this';
    const paths = extractUserContextPaths(prompt);
    assert.deepStrictEqual(paths, ['src/utils/helpers.ts']);
  });

  test('extracts multiple paths from combined context', () => {
    const prompt =
      'User\'s selected code from project/src/App.vue:L1-L50 (already provided — do not re-read):\n```\n<template>\n```\n\n' +
      'Contents of project/tsconfig.json (already provided — do not re-read):\n```\n{}\n```\n\nRefactor this';
    const paths = extractUserContextPaths(prompt);
    assert.deepStrictEqual(paths, ['project/src/App.vue', 'project/tsconfig.json']);
  });

  test('returns empty array when no context markers present', () => {
    const prompt = 'How do I implement a search controller?';
    const paths = extractUserContextPaths(prompt);
    assert.deepStrictEqual(paths, []);
  });

  test('deduplicates same path with different line ranges', () => {
    const prompt =
      'User\'s selected code from src/App.ts:L1-L50 (already provided — do not re-read):\n```\nA\n```\n\n' +
      'User\'s selected code from src/App.ts:L100-L200 (already provided — do not re-read):\n```\nB\n```\n\nFix this';
    const paths = extractUserContextPaths(prompt);
    assert.deepStrictEqual(paths, ['src/App.ts']);
  });

  test('handles single line range (no dash)', () => {
    const prompt =
      'User\'s selected code from folder/file.ts:L42 (already provided — do not re-read):\n```\ncode\n```';
    const paths = extractUserContextPaths(prompt);
    assert.deepStrictEqual(paths, ['folder/file.ts']);
  });

  test('preserves folder prefix for multi-root workspaces', () => {
    const prompt =
      'User\'s selected code from search-node-master/src/controllers/search/SearchController.ts:L118-L271 (already provided — do not re-read):\n```\ncode\n```';
    const paths = extractUserContextPaths(prompt);
    // The folder prefix must be preserved — resolveMultiRootPath handles stripping
    assert.ok(paths[0].startsWith('search-node-master/'));
  });
});

// ---------------------------------------------------------------------------
// extractUserContextBlocks
// ---------------------------------------------------------------------------

suite('extractUserContextBlocks', () => {
  test('extracts code block from selected code marker', () => {
    const prompt =
      'User\'s selected code from src/foo.ts:L10-L50 (already provided — do not re-read):\n```\nclass Foo {}\n```\n\nAnalyze this';
    const result = extractUserContextBlocks(prompt);
    assert.ok(result.includes('USER CODE'), 'Should include header');
    assert.ok(result.includes('class Foo {}'), 'Should include code content');
  });

  test('extracts code block from Contents of marker', () => {
    const prompt =
      'Contents of src/bar.ts (already provided — do not re-read):\n```\nexport const BAR = 42;\n```\n\nWhat is this?';
    const result = extractUserContextBlocks(prompt);
    assert.ok(result.includes('export const BAR = 42'), 'Should include code content');
  });

  test('returns empty string when no code blocks found', () => {
    const prompt = 'How do I implement a search controller?';
    const result = extractUserContextBlocks(prompt);
    assert.strictEqual(result, '');
  });

  test('includes all blocks regardless of size', () => {
    const bigCode = 'x'.repeat(6000);
    const prompt =
      `User's selected code from src/a.ts (already provided — do not re-read):\n\`\`\`\n${bigCode}\n\`\`\`\n\n` +
      `Contents of src/b.ts (already provided — do not re-read):\n\`\`\`\n${bigCode}\n\`\`\`\n\nFoo`;
    const result = extractUserContextBlocks(prompt);
    assert.ok(result.includes('src/a.ts'), 'First block should be included');
    assert.ok(result.includes('src/b.ts'), 'Second block should be included');
  });

  test('includes large blocks without truncation', () => {
    // Simulate a single large code selection (>12000 chars) — must be included
    const hugeCode = 'y'.repeat(15000);
    const prompt =
      `User's selected code from src/big.ts:L1-L400 (already provided — do not re-read):\n\`\`\`\n${hugeCode}\n\`\`\`\n\nAnalyze this`;
    const result = extractUserContextBlocks(prompt);
    assert.ok(result.includes('src/big.ts'), 'Large block must be included');
    assert.ok(result.includes('USER CODE'), 'Should include header');
    assert.ok(result.length > 15000, 'Content should include the large block');
  });
});

// ---------------------------------------------------------------------------
// extractSymbolMap
// ---------------------------------------------------------------------------

suite('extractSymbolMap', () => {
  test('extracts SYMBOL MAP block from prompt', () => {
    const prompt = `Some context\n\nSYMBOL MAP (pre-resolved via language server — use these locations directly, do NOT call find_definition for them):\n- HttpCall.parseUrl → src/helpers/HttpCall.ts:L45 (Method, lines 45-52)\n- SearchObject → src/helpers/Data/SearchObject.ts:L15 (Class, lines 15-209)\n\nMore text`;
    const result = extractSymbolMap(prompt);
    assert.ok(result.includes('HttpCall.parseUrl'), 'Should include first symbol');
    assert.ok(result.includes('SearchObject'), 'Should include second symbol');
    assert.ok(result.startsWith('SYMBOL MAP'), 'Should start with SYMBOL MAP header');
  });

  test('returns empty string when no SYMBOL MAP present', () => {
    const prompt = 'Regular prompt with no symbol map';
    const result = extractSymbolMap(prompt);
    assert.strictEqual(result, '');
  });
});
