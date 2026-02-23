import * as assert from 'assert';
import { MessageRecord } from '../../../../src/types/session';
import { ChatSessionController } from '../../../../src/views/chatSessionController';
import { WebviewMessageEmitter } from '../../../../src/views/chatTypes';

/**
 * Tests for ChatSessionController — specifically the filesChanged widget
 * restore behavior and session list refresh.
 *
 * Bug 1: filesChanged widget not showing on session restore when the
 *         __ui__ filesChanged event was never persisted.
 * Bug 2: Session list not refreshing pending stats after agent completes.
 */

// ─── Stub helpers ────────────────────────────────────────────────────

interface CapturedMessage {
  type: string;
  [key: string]: any;
}

function createStubEmitter(): { emitter: WebviewMessageEmitter; messages: CapturedMessage[] } {
  const messages: CapturedMessage[] = [];
  return {
    emitter: { postMessage: (msg: any) => { messages.push(msg); } },
    messages
  };
}

/** Minimal session record for tests. */
function makeSession(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: 'session_1',
    title: 'Test Session',
    mode: 'agent',
    model: 'test-model',
    status: 'completed',
    auto_approve_commands: false,
    auto_approve_sensitive_edits: false,
    sensitive_file_patterns: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides
  };
}

/** Minimal message record for tests. */
function makeMessage(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    id: `msg_${Date.now()}_${Math.random()}`,
    session_id: 'session_1',
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides
  } as MessageRecord;
}

/** Make a __ui__ filesChanged message. */
function makeFilesChangedUiMessage(checkpointId: string, files: Array<{ path: string; action: string }>): MessageRecord {
  return makeMessage({
    role: 'tool',
    content: '',
    tool_name: '__ui__',
    tool_output: JSON.stringify({
      eventType: 'filesChanged',
      payload: { checkpointId, files, status: 'pending' }
    })
  });
}

function stubDatabaseService(opts: {
  session?: any;
  messages?: MessageRecord[];
  checkpoints?: Array<{ id: string; session_id: string; message_id: string | null; status: string; created_at: number }>;
  fileSnapshots?: Record<string, Array<{ id: string; checkpoint_id: string; file_path: string; original_content: string | null; action: string; file_status: string; created_at: number }>>;
  sessions?: any[];
  pendingStats?: Map<string, { additions: number; deletions: number; fileCount: number }>;
} = {}): any {
  const {
    session = makeSession(),
    messages = [],
    checkpoints = [],
    fileSnapshots = {},
    sessions = [],
    pendingStats = new Map()
  } = opts;

  return {
    getSession: async (_id: string) => session,
    getSessionMessages: async (_id: string) => messages,
    getCheckpoints: async (_sessionId: string) => checkpoints,
    getFileSnapshots: async (checkpointId: string) => fileSnapshots[checkpointId] || [],
    listSessions: async () => ({ sessions, hasMore: false, nextOffset: 0 }),
    getSessionsPendingStats: async () => pendingStats,
    updateSessionStatus: async () => {},
    createSession: async () => session
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('ChatSessionController', () => {

  // ----- ensureFilesChangedWidget (Bug 1) -----

  suite('ensureFilesChangedWidget fallback', () => {

    test('sends synthetic filesChanged when no __ui__ event exists but checkpoints are pending', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ id: 'session_x' }),
        messages: [
          makeMessage({ role: 'user', content: 'edit my file' }),
          makeMessage({ role: 'assistant', content: 'Done!' })
        ],
        checkpoints: [
          { id: 'ckpt_1', session_id: 'session_x', message_id: null, status: 'pending', created_at: 1 }
        ],
        fileSnapshots: {
          ckpt_1: [
            { id: 'snap_1', checkpoint_id: 'ckpt_1', file_path: 'src/foo.ts', original_content: null, action: 'modified', file_status: 'pending', created_at: 1 }
          ]
        }
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_x');

      // Should have: loadSessionMessages, filesChanged, generationStopped
      const fcMessages = captured.filter(m => m.type === 'filesChanged');
      assert.strictEqual(fcMessages.length, 1, 'Expected exactly one synthetic filesChanged message');
      assert.strictEqual(fcMessages[0].checkpointId, 'ckpt_1');
      assert.deepStrictEqual(fcMessages[0].files, [{ path: 'src/foo.ts', action: 'modified' }]);
      assert.strictEqual(fcMessages[0].status, 'pending');
    });

    test('does NOT send synthetic filesChanged when __ui__ event already exists', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ id: 'session_y' }),
        messages: [
          makeMessage({ role: 'user', content: 'edit my file' }),
          makeMessage({ role: 'assistant', content: 'Done!' }),
          makeFilesChangedUiMessage('ckpt_1', [{ path: 'src/foo.ts', action: 'modified' }])
        ],
        checkpoints: [
          { id: 'ckpt_1', session_id: 'session_y', message_id: null, status: 'pending', created_at: 1 }
        ],
        fileSnapshots: {
          ckpt_1: [
            { id: 'snap_1', checkpoint_id: 'ckpt_1', file_path: 'src/foo.ts', original_content: null, action: 'modified', file_status: 'pending', created_at: 1 }
          ]
        }
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_y');

      // The only filesChanged-like data should be embedded in loadSessionMessages,
      // NOT a separate synthetic filesChanged message
      const fcMessages = captured.filter(m => m.type === 'filesChanged');
      assert.strictEqual(fcMessages.length, 0, 'Should not send synthetic filesChanged when __ui__ event exists');
    });

    test('does NOT send synthetic filesChanged for kept/undone checkpoints', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ id: 'session_z' }),
        messages: [
          makeMessage({ role: 'user', content: 'edit my file' }),
          makeMessage({ role: 'assistant', content: 'Done!' })
        ],
        checkpoints: [
          { id: 'ckpt_1', session_id: 'session_z', message_id: null, status: 'kept', created_at: 1 }
        ],
        fileSnapshots: {}
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_z');

      const fcMessages = captured.filter(m => m.type === 'filesChanged');
      assert.strictEqual(fcMessages.length, 0, 'Should not send filesChanged for kept checkpoints');
    });

    test('sends multiple filesChanged for multiple pending checkpoints', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ id: 'session_multi' }),
        messages: [
          makeMessage({ role: 'user', content: 'edit files' }),
          makeMessage({ role: 'assistant', content: 'Done!' })
        ],
        checkpoints: [
          { id: 'ckpt_1', session_id: 'session_multi', message_id: null, status: 'pending', created_at: 1 },
          { id: 'ckpt_2', session_id: 'session_multi', message_id: null, status: 'partial', created_at: 2 }
        ],
        fileSnapshots: {
          ckpt_1: [
            { id: 'snap_1', checkpoint_id: 'ckpt_1', file_path: 'src/a.ts', original_content: null, action: 'modified', file_status: 'pending', created_at: 1 }
          ],
          ckpt_2: [
            { id: 'snap_2', checkpoint_id: 'ckpt_2', file_path: 'src/b.ts', original_content: null, action: 'created', file_status: 'pending', created_at: 2 }
          ]
        }
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_multi');

      const fcMessages = captured.filter(m => m.type === 'filesChanged');
      assert.strictEqual(fcMessages.length, 2, 'Expected two synthetic filesChanged messages');
      assert.strictEqual(fcMessages[0].checkpointId, 'ckpt_1');
      assert.strictEqual(fcMessages[1].checkpointId, 'ckpt_2');
    });

    test('skips checkpoints with no pending file_snapshots', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ id: 'session_no_files' }),
        messages: [
          makeMessage({ role: 'user', content: 'do something' })
        ],
        checkpoints: [
          { id: 'ckpt_1', session_id: 'session_no_files', message_id: null, status: 'pending', created_at: 1 }
        ],
        fileSnapshots: {
          // Checkpoint is pending but all snapshots are already kept
          ckpt_1: [
            { id: 'snap_1', checkpoint_id: 'ckpt_1', file_path: 'src/a.ts', original_content: null, action: 'modified', file_status: 'kept', created_at: 1 }
          ]
        }
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_no_files');

      const fcMessages = captured.filter(m => m.type === 'filesChanged');
      assert.strictEqual(fcMessages.length, 0, 'Should not send filesChanged when all snapshots are already resolved');
    });
  });

  // ----- generationStopped ordering -----

  suite('loadSession message ordering', () => {

    test('loadSession sends loadSessionMessages before generationStopped', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ status: 'completed' }),
        messages: [makeMessage({ role: 'user', content: 'hi' })]
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_1');

      const types = captured.map(m => m.type);
      const loadIdx = types.indexOf('loadSessionMessages');
      const stopIdx = types.indexOf('generationStopped');
      assert.ok(loadIdx >= 0, 'Should have loadSessionMessages');
      assert.ok(stopIdx >= 0, 'Should have generationStopped');
      assert.ok(loadIdx < stopIdx, 'loadSessionMessages should come before generationStopped');
    });

    test('filesChanged synthetic messages come after loadSessionMessages', async () => {
      const { emitter, messages: captured } = createStubEmitter();
      const dbService = stubDatabaseService({
        session: makeSession({ id: 'session_order' }),
        messages: [
          makeMessage({ role: 'user', content: 'edit file' })
        ],
        checkpoints: [
          { id: 'ckpt_1', session_id: 'session_order', message_id: null, status: 'pending', created_at: 1 }
        ],
        fileSnapshots: {
          ckpt_1: [
            { id: 'snap_1', checkpoint_id: 'ckpt_1', file_path: 'src/foo.ts', original_content: null, action: 'modified', file_status: 'pending', created_at: 1 }
          ]
        }
      });

      const controller = new ChatSessionController(dbService, emitter, () => false);
      await controller.loadSession('session_order');

      const types = captured.map(m => m.type);
      const loadIdx = types.indexOf('loadSessionMessages');
      const fcIdx = types.indexOf('filesChanged');
      const stopIdx = types.indexOf('generationStopped');
      assert.ok(loadIdx < fcIdx, 'filesChanged should come after loadSessionMessages');
      assert.ok(fcIdx < stopIdx, 'filesChanged should come before generationStopped');
    });
  });
});
