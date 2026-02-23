import * as assert from 'assert';
import { WebviewMessageEmitter } from '../../../../src/views/chatTypes';
import { FileChangeMessageHandler } from '../../../../src/views/messageHandlers/fileChangeMessageHandler';

/**
 * Tests for FileChangeMessageHandler — specifically the try/catch robustness
 * of keep/undo operations.
 *
 * Regressions tested:
 * 1. If keepFile/undoFile throws, the handler must still send a fileChangeResult
 *    with success:false to the webview (not swallow the error silently).
 * 2. If keepAllChanges/undoAllChanges throws, keepUndoResult must still be sent.
 * 3. The sessionId must be resolved from the controller when not provided by webview.
 */

// ─── Stub helpers ────────────────────────────────────────────────────

interface CapturedMessage {
  type: string;
  [key: string]: any;
}

interface CapturedPersistCall {
  sessionId: string | undefined;
  eventType: string;
  payload: Record<string, any>;
}

function createStubEmitter(): { emitter: WebviewMessageEmitter; messages: CapturedMessage[] } {
  const messages: CapturedMessage[] = [];
  return {
    emitter: { postMessage: (msg: any) => { messages.push(msg); } },
    messages
  };
}

function createStubSessionController(sessionId = 'sess_1'): any {
  return {
    getCurrentSessionId: () => sessionId,
    sendSessionsList: async () => {}
  };
}

function createStubAgentExecutor(overrides: Record<string, any> = {}): { executor: any; persistCalls: CapturedPersistCall[] } {
  const persistCalls: CapturedPersistCall[] = [];
  const executor = {
    keepFile: async () => ({ success: true }),
    undoFile: async () => ({ success: true }),
    keepAllChanges: async () => ({ success: true }),
    undoAllChanges: async () => ({ success: true, errors: [] }),
    computeFilesDiffStats: async () => [],
    openSnapshotDiff: async () => {},
    persistUiEvent: async (sessionId: string | undefined, eventType: string, payload: Record<string, any>) => {
      persistCalls.push({ sessionId, eventType, payload });
    },
    ...overrides
  };
  return { executor, persistCalls };
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('FileChangeMessageHandler', () => {

  suite('keepFile error handling', () => {

    test('sends fileChangeResult with success:true when keepFile succeeds', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor, persistCalls } = createStubAgentExecutor();

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'keepFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const result = messages.find(m => m.type === 'fileChangeResult');
      assert.ok(result, 'fileChangeResult should be posted');
      assert.strictEqual(result!.success, true);
      assert.strictEqual(result!.filePath, 'foo.ts');
      assert.strictEqual(result!.action, 'kept');

      const persisted = persistCalls.find(c => c.eventType === 'fileChangeResult');
      assert.ok(persisted, 'fileChangeResult should be persisted');
      assert.strictEqual(persisted!.payload.success, true);
    });

    test('sends fileChangeResult with success:false when keepFile throws', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor, persistCalls } = createStubAgentExecutor({
        keepFile: async () => { throw new Error('DB crash'); }
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);

      // Should NOT throw
      await handler.handle({ type: 'keepFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const result = messages.find(m => m.type === 'fileChangeResult');
      assert.ok(result, 'fileChangeResult should still be posted on error');
      assert.strictEqual(result!.success, false);
      assert.strictEqual(result!.filePath, 'foo.ts');

      const persisted = persistCalls.find(c => c.eventType === 'fileChangeResult');
      assert.ok(persisted, 'fileChangeResult should still be persisted on error');
      assert.strictEqual(persisted!.payload.success, false);
    });

    test('resolves sessionId from controller when webview omits it', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController('resolved_session');
      const { executor } = createStubAgentExecutor();

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      // Webview doesn't send sessionId
      await handler.handle({ type: 'keepFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const result = messages.find(m => m.type === 'fileChangeResult');
      assert.strictEqual(result!.sessionId, 'resolved_session');
    });
  });

  suite('undoFile error handling', () => {

    test('sends fileChangeResult with success:false when undoFile throws', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor, persistCalls } = createStubAgentExecutor({
        undoFile: async () => { throw new Error('FS error'); }
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'undoFile', checkpointId: 'ckpt_1', filePath: 'bar.ts' });

      const result = messages.find(m => m.type === 'fileChangeResult');
      assert.ok(result, 'fileChangeResult should still be posted on error');
      assert.strictEqual(result!.success, false);
      assert.strictEqual(result!.action, 'undone');

      const persisted = persistCalls.find(c => c.eventType === 'fileChangeResult');
      assert.strictEqual(persisted!.payload.success, false);
    });

    test('sends fileChangeResult with success:true when undoFile succeeds', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor({
        undoFile: async () => ({ success: true })
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'undoFile', checkpointId: 'ckpt_1', filePath: 'bar.ts' });

      const result = messages.find(m => m.type === 'fileChangeResult');
      assert.ok(result);
      assert.strictEqual(result!.success, true);
      assert.strictEqual(result!.action, 'undone');
    });
  });

  suite('keepAllChanges error handling', () => {

    test('sends keepUndoResult with success:false when keepAllChanges throws', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor, persistCalls } = createStubAgentExecutor({
        keepAllChanges: async () => { throw new Error('Bulk error'); }
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'keepAllChanges', checkpointId: 'ckpt_1' });

      const result = messages.find(m => m.type === 'keepUndoResult');
      assert.ok(result, 'keepUndoResult should still be posted on error');
      assert.strictEqual(result!.success, false);
      assert.strictEqual(result!.action, 'kept');

      const persisted = persistCalls.find(c => c.eventType === 'keepUndoResult');
      assert.strictEqual(persisted!.payload.success, false);
    });

    test('sends keepUndoResult with success:true on success', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor();

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'keepAllChanges', checkpointId: 'ckpt_1' });

      const result = messages.find(m => m.type === 'keepUndoResult');
      assert.ok(result);
      assert.strictEqual(result!.success, true);
      assert.strictEqual(result!.action, 'kept');
    });
  });

  suite('undoAllChanges error handling', () => {

    test('sends keepUndoResult with success:false when undoAllChanges throws', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor, persistCalls } = createStubAgentExecutor({
        undoAllChanges: async () => { throw new Error('Undo all failed'); }
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'undoAllChanges', checkpointId: 'ckpt_1' });

      const result = messages.find(m => m.type === 'keepUndoResult');
      assert.ok(result, 'keepUndoResult should still be posted on error');
      assert.strictEqual(result!.success, false);
      assert.strictEqual(result!.action, 'undone');

      const persisted = persistCalls.find(c => c.eventType === 'keepUndoResult');
      assert.strictEqual(persisted!.payload.success, false);
    });

    test('includes errors array from successful undoAllChanges', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor({
        undoAllChanges: async () => ({ success: true, errors: ['partial failure'] })
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'undoAllChanges', checkpointId: 'ckpt_1' });

      const result = messages.find(m => m.type === 'keepUndoResult');
      assert.ok(result);
      assert.strictEqual(result!.success, true);
      assert.deepStrictEqual(result!.errors, ['partial failure']);
    });
  });

  // ─── REGRESSION: requestFilesDiffStats always computes fresh stats ───

  suite('requestFilesDiffStats — re-edit freshness', () => {

    test('always calls computeFilesDiffStats and posts fresh stats', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();

      let callCount = 0;
      const { executor } = createStubAgentExecutor({
        computeFilesDiffStats: async (_checkpointId: string) => {
          callCount++;
          // Simulate increasing stats on each call (file re-edited)
          return [{ path: 'a.ts', additions: callCount * 10, deletions: callCount, action: 'modified' }];
        }
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);

      // First stats request (when file first appears in widget)
      await handler.handle({ type: 'requestFilesDiffStats', checkpointId: 'ckpt_1' });

      const firstStats = messages.filter(m => m.type === 'filesDiffStats');
      assert.strictEqual(firstStats.length, 1);
      assert.strictEqual(firstStats[0].files[0].additions, 10);
      assert.strictEqual(firstStats[0].files[0].deletions, 1);

      // Second stats request (after same file re-edited → webview requests again)
      await handler.handle({ type: 'requestFilesDiffStats', checkpointId: 'ckpt_1' });

      const allStats = messages.filter(m => m.type === 'filesDiffStats');
      assert.strictEqual(allStats.length, 2, 'Should compute and post stats twice');
      assert.strictEqual(allStats[1].files[0].additions, 20, 'Second call should show updated stats');
      assert.strictEqual(allStats[1].files[0].deletions, 2);

      // computeFilesDiffStats was called twice (not cached)
      assert.strictEqual(callCount, 2);
    });

    test('posts filesDiffStats even when computeFilesDiffStats returns empty array', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor({
        computeFilesDiffStats: async () => []
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'requestFilesDiffStats', checkpointId: 'ckpt_1' });

      const stats = messages.filter(m => m.type === 'filesDiffStats');
      assert.strictEqual(stats.length, 1);
      assert.deepStrictEqual(stats[0].files, []);
    });

    test('does not crash when computeFilesDiffStats throws', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor({
        computeFilesDiffStats: async () => { throw new Error('DB unavailable'); }
      });

      const handler = new FileChangeMessageHandler(emitter, controller, executor);

      // Should not throw
      await handler.handle({ type: 'requestFilesDiffStats', checkpointId: 'ckpt_1' });

      // No filesDiffStats posted (error was caught)
      const stats = messages.filter(m => m.type === 'filesDiffStats');
      assert.strictEqual(stats.length, 0);
    });
  });

  // ─── REGRESSION: keep/undo sends reviewChangePosition to update counter ───

  suite('keep/undo updates Change X of Y counter', () => {

    function createStubReviewService(position: { current: number; total: number; filePath: string } | null = null): any {
      return {
        removeFileFromReview: () => {},
        closeReview: () => {},
        startReviewForCheckpoint: async () => {},
        getChangePosition: () => position
      };
    }

    test('keepFile sends reviewChangePosition after removing file from review', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor();
      const reviewService = createStubReviewService({ current: 2, total: 5, filePath: 'bar.ts' });

      const handler = new FileChangeMessageHandler(emitter, controller, executor, reviewService);
      await handler.handle({ type: 'keepFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const posMsg = messages.find(m => m.type === 'reviewChangePosition');
      assert.ok(posMsg, 'reviewChangePosition should be posted after keepFile');
      assert.strictEqual(posMsg!.current, 2);
      assert.strictEqual(posMsg!.total, 5);
      assert.strictEqual(posMsg!.filePath, 'bar.ts');
    });

    test('undoFile sends reviewChangePosition after removing file from review', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor();
      const reviewService = createStubReviewService({ current: 1, total: 3, filePath: 'baz.ts' });

      const handler = new FileChangeMessageHandler(emitter, controller, executor, reviewService);
      await handler.handle({ type: 'undoFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const posMsg = messages.find(m => m.type === 'reviewChangePosition');
      assert.ok(posMsg, 'reviewChangePosition should be posted after undoFile');
      assert.strictEqual(posMsg!.current, 1);
      assert.strictEqual(posMsg!.total, 3);
    });

    test('no reviewChangePosition when review session is empty after removal', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor();
      // After removing the last file, getChangePosition returns null
      const reviewService = createStubReviewService(null);

      const handler = new FileChangeMessageHandler(emitter, controller, executor, reviewService);
      await handler.handle({ type: 'keepFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const posMsg = messages.find(m => m.type === 'reviewChangePosition');
      assert.ok(!posMsg, 'reviewChangePosition should NOT be posted when no position');
    });

    test('no reviewChangePosition when reviewService is not provided', async () => {
      const { emitter, messages } = createStubEmitter();
      const controller = createStubSessionController();
      const { executor } = createStubAgentExecutor();

      // No reviewService passed (4th arg omitted)
      const handler = new FileChangeMessageHandler(emitter, controller, executor);
      await handler.handle({ type: 'undoFile', checkpointId: 'ckpt_1', filePath: 'foo.ts' });

      const posMsg = messages.find(m => m.type === 'reviewChangePosition');
      assert.ok(!posMsg, 'reviewChangePosition should NOT be posted without reviewService');
    });
  });
});
