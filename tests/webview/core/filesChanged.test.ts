import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { vscodePostMessage } from '../setup';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
  vscodePostMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Live message handlers
// ---------------------------------------------------------------------------

describe('handleFilesChanged — ONE widget', () => {
  test('first filesChanged event creates exactly one block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({
      checkpointId: 'ckpt_1',
      files: [{ path: 'a.ts', action: 'modified' }],
      status: 'pending'
    });

    expect(state.filesChangedBlocks.value.length).toBe(1);
    const block = state.filesChangedBlocks.value[0];
    expect(block.checkpointIds).toEqual(['ckpt_1']);
    expect(block.files.length).toBe(1);
    expect(block.files[0].path).toBe('a.ts');
    expect(block.files[0].checkpointId).toBe('ckpt_1');
  });

  test('second filesChanged from different checkpoint merges into SAME block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({
      checkpointId: 'ckpt_1',
      files: [{ path: 'a.ts', action: 'modified' }],
      status: 'pending'
    });
    handleFilesChanged({
      checkpointId: 'ckpt_2',
      files: [{ path: 'b.ts', action: 'created' }],
      status: 'pending'
    });

    // Still ONE block
    expect(state.filesChangedBlocks.value.length).toBe(1);
    const block = state.filesChangedBlocks.value[0];
    expect(block.checkpointIds).toEqual(['ckpt_1', 'ckpt_2']);
    expect(block.files.length).toBe(2);
    expect(block.files[0].path).toBe('a.ts');
    expect(block.files[0].checkpointId).toBe('ckpt_1');
    expect(block.files[1].path).toBe('b.ts');
    expect(block.files[1].checkpointId).toBe('ckpt_2');
  });

  test('three checkpoints still produce ONE block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_3', files: [{ path: 'c.ts' }] });

    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files.length).toBe(3);
    expect(state.filesChangedBlocks.value[0].checkpointIds).toEqual(['ckpt_1', 'ckpt_2', 'ckpt_3']);
  });

  test('duplicate files from same checkpoint are not added twice', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }, { path: 'b.ts' }] });

    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files.length).toBe(2);
  });

  test('duplicate checkpointId is not added to checkpointIds twice', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'b.ts' }] });

    expect(state.filesChangedBlocks.value[0].checkpointIds).toEqual(['ckpt_1']);
  });
});

describe('handleFilesDiffStats', () => {
  test('populates stats on files matching checkpoint', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleFilesDiffStats } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }] });

    handleFilesDiffStats({
      checkpointId: 'ckpt_1',
      files: [{ path: 'a.ts', additions: 10, deletions: 2 }]
    });

    const block = state.filesChangedBlocks.value[0];
    expect(block.files[0].additions).toBe(10);
    expect(block.files[0].deletions).toBe(2);
    // b.ts should still have no stats
    expect(block.files[1].additions).toBeUndefined();

    handleFilesDiffStats({
      checkpointId: 'ckpt_2',
      files: [{ path: 'b.ts', additions: 5, deletions: 0 }]
    });

    expect(block.files[1].additions).toBe(5);
    expect(block.totalAdditions).toBe(15);
    expect(block.totalDeletions).toBe(2);
  });
});

describe('handleFileChangeResult — per-file keep/undo', () => {
  test('removes a single file, keeps the rest', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleFileChangeResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }, { path: 'b.ts' }] });

    handleFileChangeResult({ checkpointId: 'ckpt_1', filePath: 'a.ts', action: 'kept', success: true });

    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files[0].path).toBe('b.ts');
  });

  test('removes block when last file is resolved', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleFileChangeResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFileChangeResult({ checkpointId: 'ckpt_1', filePath: 'a.ts', action: 'kept', success: true });

    expect(state.filesChangedBlocks.value.length).toBe(0);
  });

  test('cleans up checkpointId when all its files are resolved', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleFileChangeResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }] });

    handleFileChangeResult({ checkpointId: 'ckpt_1', filePath: 'a.ts', action: 'kept', success: true });

    const block = state.filesChangedBlocks.value[0];
    expect(block.checkpointIds).toEqual(['ckpt_2']);
    expect(block.files.length).toBe(1);
    expect(block.files[0].path).toBe('b.ts');
  });
});

describe('handleKeepUndoResult — bulk keep/undo', () => {
  test('keepAll for one checkpoint removes only its files', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleKeepUndoResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_2', files: [{ path: 'c.ts' }] });

    handleKeepUndoResult({ checkpointId: 'ckpt_1', action: 'kept', success: true });

    // Block still exists with ckpt_2's file
    expect(state.filesChangedBlocks.value.length).toBe(1);
    const block = state.filesChangedBlocks.value[0];
    expect(block.checkpointIds).toEqual(['ckpt_2']);
    expect(block.files.length).toBe(1);
    expect(block.files[0].path).toBe('c.ts');
  });

  test('keepAll for all checkpoints removes the block entirely', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleKeepUndoResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }] });

    handleKeepUndoResult({ checkpointId: 'ckpt_1', action: 'kept', success: true });
    handleKeepUndoResult({ checkpointId: 'ckpt_2', action: 'kept', success: true });

    expect(state.filesChangedBlocks.value.length).toBe(0);
  });

  test('undoAll removes files for that checkpoint', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleKeepUndoResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });
    handleFilesChanged({ checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }] });

    handleKeepUndoResult({ checkpointId: 'ckpt_2', action: 'undone', success: true });

    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files[0].path).toBe('a.ts');
  });

  test('failed keepAll does not remove files', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleKeepUndoResult } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });

    handleKeepUndoResult({ checkpointId: 'ckpt_1', action: 'kept', success: false });

    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].files.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Actions — webview → backend messages
// ---------------------------------------------------------------------------

describe('filesChanged actions', () => {
  test('keepAllChanges sends keepAllChanges for each checkpointId', async () => {
    const actions = await import('../../../src/webview/scripts/core/actions/filesChanged');

    actions.keepAllChanges(['ckpt_1', 'ckpt_2']);

    expect(vscodePostMessage).toHaveBeenCalledTimes(2);
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'keepAllChanges', checkpointId: 'ckpt_1' });
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'keepAllChanges', checkpointId: 'ckpt_2' });
  });

  test('undoAllChanges sends undoAllChanges for each checkpointId', async () => {
    const actions = await import('../../../src/webview/scripts/core/actions/filesChanged');

    actions.undoAllChanges(['ckpt_1', 'ckpt_2', 'ckpt_3']);

    expect(vscodePostMessage).toHaveBeenCalledTimes(3);
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'undoAllChanges', checkpointId: 'ckpt_1' });
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'undoAllChanges', checkpointId: 'ckpt_2' });
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'undoAllChanges', checkpointId: 'ckpt_3' });
  });

  test('keepFile sends keepFile with file checkpointId', async () => {
    const actions = await import('../../../src/webview/scripts/core/actions/filesChanged');

    actions.keepFile('ckpt_1', 'a.ts');

    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'keepFile', checkpointId: 'ckpt_1', filePath: 'a.ts' });
  });

  test('undoFile sends undoFile with file checkpointId', async () => {
    const actions = await import('../../../src/webview/scripts/core/actions/filesChanged');

    actions.undoFile('ckpt_2', 'b.ts');

    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'undoFile', checkpointId: 'ckpt_2', filePath: 'b.ts' });
  });
});

// ---------------------------------------------------------------------------
// Timeline builder — session history produces ONE block
// ---------------------------------------------------------------------------

describe('timelineBuilder — filesChanged merging', () => {
  test('two filesChanged events from different checkpoints produce ONE block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const messages = [
      { id: 'u1', role: 'user', content: 'task 1' },
      { id: 'a1', role: 'assistant', content: 'Done task 1' },
      { id: 'fc1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_1', files: [{ path: 'a.ts', action: 'modified' }], status: 'pending' }
      })},
      { id: 'u2', role: 'user', content: 'task 2' },
      { id: 'a2', role: 'assistant', content: 'Done task 2' },
      { id: 'fc2', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_2', files: [{ path: 'b.ts', action: 'created' }], status: 'pending' }
      })}
    ];

    builder.buildTimelineFromMessages(messages);

    // ONE block with files from both checkpoints
    expect(state.filesChangedBlocks.value.length).toBe(1);
    const block = state.filesChangedBlocks.value[0];
    expect(block.checkpointIds).toEqual(['ckpt_1', 'ckpt_2']);
    expect(block.files.length).toBe(2);
    expect(block.files[0].path).toBe('a.ts');
    expect(block.files[0].checkpointId).toBe('ckpt_1');
    expect(block.files[1].path).toBe('b.ts');
    expect(block.files[1].checkpointId).toBe('ckpt_2');
  });

  test('keepUndoResult removes only that checkpoint files from history', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const messages = [
      { id: 'u1', role: 'user', content: 'task 1' },
      { id: 'fc1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }], status: 'pending' }
      })},
      { id: 'u2', role: 'user', content: 'task 2' },
      { id: 'fc2', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }], status: 'pending' }
      })},
      { id: 'ku1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'keepUndoResult',
        payload: { checkpointId: 'ckpt_1', action: 'kept', success: true }
      })}
    ];

    builder.buildTimelineFromMessages(messages);

    expect(state.filesChangedBlocks.value.length).toBe(1);
    const block = state.filesChangedBlocks.value[0];
    expect(block.checkpointIds).toEqual(['ckpt_2']);
    expect(block.files.length).toBe(1);
    expect(block.files[0].path).toBe('b.ts');
  });

  test('all checkpoints resolved removes the block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const messages = [
      { id: 'fc1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }], status: 'pending' }
      })},
      { id: 'fc2', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }], status: 'pending' }
      })},
      { id: 'ku1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'keepUndoResult',
        payload: { checkpointId: 'ckpt_1', action: 'kept', success: true }
      })},
      { id: 'ku2', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'keepUndoResult',
        payload: { checkpointId: 'ckpt_2', action: 'undone', success: true }
      })}
    ];

    builder.buildTimelineFromMessages(messages);

    expect(state.filesChangedBlocks.value.length).toBe(0);
  });

  test('fileChangeResult removes single file from merged block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const messages = [
      { id: 'fc1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }, { path: 'b.ts' }], status: 'pending' }
      })},
      { id: 'fc2', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_2', files: [{ path: 'c.ts' }], status: 'pending' }
      })},
      { id: 'fcr1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'fileChangeResult',
        payload: { checkpointId: 'ckpt_1', filePath: 'a.ts', action: 'kept', success: true }
      })}
    ];

    builder.buildTimelineFromMessages(messages);

    expect(state.filesChangedBlocks.value.length).toBe(1);
    const block = state.filesChangedBlocks.value[0];
    expect(block.files.length).toBe(2);
    expect(block.files.map(f => f.path)).toEqual(['b.ts', 'c.ts']);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: Diff stats must be re-fetched after session restore
// ---------------------------------------------------------------------------

describe('REGRESSION: session restore requests diff stats for all checkpoints', () => {
  test('handleLoadSessionMessages requests stats for every checkpointId in restored block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    // Simulate a session load with two filesChanged events (two checkpoints)
    const messages = [
      { id: 'u1', role: 'user', content: 'task 1' },
      { id: 'a1', role: 'assistant', content: 'Done' },
      { id: 'fc1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }], status: 'pending' }
      })},
      { id: 'fc2', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_2', files: [{ path: 'b.ts' }], status: 'pending' }
      })}
    ];

    vscodePostMessage.mockClear();

    handlers.handleLoadSessionMessages({
      type: 'loadSessionMessages',
      messages,
      sessionId: 'test-session',
      autoApproveCommands: false,
      autoApproveSensitiveEdits: false,
    });

    // The restored block should have both checkpoints
    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].checkpointIds).toEqual(['ckpt_1', 'ckpt_2']);

    // CRITICAL: requestFilesDiffStats must be sent for EACH checkpointId
    const statsRequests = vscodePostMessage.mock.calls.filter(
      (call: any[]) => call[0]?.type === 'requestFilesDiffStats'
    );
    expect(statsRequests.length).toBe(2);
    expect(statsRequests.map((c: any[]) => c[0].checkpointId).sort()).toEqual(['ckpt_1', 'ckpt_2']);
  });

  test('restored pending block has statsLoading=true so stats are requested', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const messages = [
      { id: 'fc1', role: 'tool', toolName: '__ui__', toolOutput: JSON.stringify({
        eventType: 'filesChanged',
        payload: { checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }], status: 'pending' }
      })}
    ];

    builder.buildTimelineFromMessages(messages);

    expect(state.filesChangedBlocks.value.length).toBe(1);
    expect(state.filesChangedBlocks.value[0].statsLoading).toBe(true);
    // Files start with additions=undefined (not populated from DB)
    expect(state.filesChangedBlocks.value[0].files[0].additions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: handleFilesChanged re-requests stats for old checkpoint files missing stats
// ---------------------------------------------------------------------------

describe('REGRESSION: safety net re-requests missing stats on new file addition', () => {
  test('adding new file triggers stats request for old checkpoint files without stats', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    // Simulate state after session restore: block exists with files but no stats
    state.filesChangedBlocks.value = [{
      type: 'filesChanged' as const,
      checkpointIds: ['ckpt_1'],
      files: [
        { path: 'a.ts', action: 'modified', additions: undefined, deletions: undefined, status: 'pending' as const, checkpointId: 'ckpt_1' },
        { path: 'b.ts', action: 'modified', additions: undefined, deletions: undefined, status: 'pending' as const, checkpointId: 'ckpt_1' }
      ],
      totalAdditions: undefined,
      totalDeletions: undefined,
      status: 'pending' as const,
      collapsed: false,
      statsLoading: false
    }];

    vscodePostMessage.mockClear();

    // New agent task adds a file from a new checkpoint
    handleFilesChanged({
      checkpointId: 'ckpt_2',
      files: [{ path: 'c.ts', action: 'created' }]
    });

    const statsRequests = vscodePostMessage.mock.calls.filter(
      (call: any[]) => call[0]?.type === 'requestFilesDiffStats'
    );

    // Should request stats for BOTH ckpt_2 (new) AND ckpt_1 (old, missing stats)
    expect(statsRequests.length).toBe(2);
    const requestedIds = statsRequests.map((c: any[]) => c[0].checkpointId).sort();
    expect(requestedIds).toEqual(['ckpt_1', 'ckpt_2']);
  });

  test('does NOT re-request stats for checkpoints that already have stats', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    // Block exists with files that HAVE stats (normal live scenario)
    state.filesChangedBlocks.value = [{
      type: 'filesChanged' as const,
      checkpointIds: ['ckpt_1'],
      files: [
        { path: 'a.ts', action: 'modified', additions: 10, deletions: 2, status: 'pending' as const, checkpointId: 'ckpt_1' }
      ],
      totalAdditions: 10,
      totalDeletions: 2,
      status: 'pending' as const,
      collapsed: false,
      statsLoading: false
    }];

    vscodePostMessage.mockClear();

    // New agent task adds a file
    handleFilesChanged({
      checkpointId: 'ckpt_2',
      files: [{ path: 'b.ts', action: 'created' }]
    });

    const statsRequests = vscodePostMessage.mock.calls.filter(
      (call: any[]) => call[0]?.type === 'requestFilesDiffStats'
    );

    // Should ONLY request stats for ckpt_2 (new), NOT ckpt_1 (already has stats)
    expect(statsRequests.length).toBe(1);
    expect(statsRequests[0][0].checkpointId).toBe('ckpt_2');
  });

  test('no extra requests when all existing files have stats', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];

    // Normal live flow: first file → stats requested
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });

    vscodePostMessage.mockClear();

    // Same checkpoint, existing file not re-added → no stats request
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });

    const statsRequests = vscodePostMessage.mock.calls.filter(
      (call: any[]) => call[0]?.type === 'requestFilesDiffStats'
    );
    // File already exists → added=false → no stats request at all
    expect(statsRequests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reviewChangePosition handler still populates block properties
// Nav uses backend change-position data (hunk-level), NOT file count.
// ---------------------------------------------------------------------------

describe('REGRESSION: nav uses change-level counter from reviewChangePosition', () => {
  test('reviewChangePosition updates currentChange and totalChanges on the block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleReviewChangePosition } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });

    handleReviewChangePosition({ current: 3, total: 7 });

    const block = state.filesChangedBlocks.value[0];
    expect(block.currentChange).toBe(3);
    expect(block.totalChanges).toBe(7);
  });

  test('nav bar is hidden until totalChanges is set (prevents "Change 0 of 0")', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [{ path: 'a.ts' }] });

    const block = state.filesChangedBlocks.value[0];
    // Nav bar v-if="block.totalChanges" → hidden when undefined/0.
    expect(block.currentChange).toBeUndefined();
    expect(block.totalChanges).toBeUndefined();
  });

  test('totalChanges reflects hunk count, NOT file count', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleFilesChanged, handleReviewChangePosition } = await import('../../../src/webview/scripts/core/messageHandlers/filesChanged');

    state.filesChangedBlocks.value = [];
    // 5 files in the widget...
    handleFilesChanged({ checkpointId: 'ckpt_1', files: [
      { path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' },
      { path: 'd.ts' }, { path: 'e.ts' },
    ] });

    // ...but the review service finds 12 hunks across those files
    handleReviewChangePosition({ current: 1, total: 12 });

    const block = state.filesChangedBlocks.value[0];
    expect(block.files.length).toBe(5);
    // Nav must show "Change X of 12", NOT "Change X of 5"
    expect(block.totalChanges).toBe(12);
    expect(block.currentChange).toBe(1);
  });

  test('navigatePrevChange and navigateNextChange post checkpointIds array', async () => {
    const actions = await import('../../../src/webview/scripts/core/actions/filesChanged');
    const { vi } = await import('vitest');
    const state = await import('../../../src/webview/scripts/core/state');
    const spy = vi.spyOn(state.vscode, 'postMessage');

    actions.navigatePrevChange(['ckpt_1', 'ckpt_2']);
    expect(spy).toHaveBeenCalledWith({ type: 'navigateReviewPrev', checkpointIds: ['ckpt_1', 'ckpt_2'] });

    spy.mockClear();
    actions.navigateNextChange(['ckpt_1', 'ckpt_2']);
    expect(spy).toHaveBeenCalledWith({ type: 'navigateReviewNext', checkpointIds: ['ckpt_1', 'ckpt_2'] });
  });
});
