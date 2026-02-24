import * as assert from 'assert';
import { extractUserContextPaths } from '../../../../src/agent/execution/orchestration/agentChatExecutor';

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
