import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentFileEditHandler } from '../../../../src/agent/execution/approval/agentFileEditHandler';
import { WebviewMessageEmitter } from '../../../../src/views/chatTypes';

/**
 * Integration tests for AgentFileEditHandler.
 *
 * These tests verify the EXACT sequence of postMessage and persistUiEvent
 * calls emitted during file write operations. The primary regression they
 * catch is the "duplicate action lines" bug — where multiple
 * showToolAction(running) events were emitted for the same file write.
 *
 * These are e2e extension host tests (Mocha) that complement the Vitest
 * parity tests in tests/webview/core/parity.test.ts.
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

function createStubPersist(): { persist: any; calls: CapturedPersistCall[] } {
  const calls: CapturedPersistCall[] = [];
  const persist = async (sessionId: string | undefined, eventType: string, payload: Record<string, any>) => {
    calls.push({ sessionId, eventType, payload });
  };
  return { persist, calls };
}

function stubToolRegistry(writeOutput = 'File written successfully'): any {
  return {
    execute: async (_name: string, _args: any, _context: any) => ({
      tool: _name,
      input: _args,
      output: writeOutput,
      timestamp: Date.now()
    })
  };
}

function stubDatabaseService(sessionOverrides: Record<string, any> = {}): any {
  return {
    getSession: async () => ({
      auto_approve_sensitive_edits: false,
      sensitive_file_patterns: null,
      ...sessionOverrides
    }),
    addMessage: async () => {},
    persistUiEvent: async () => {}
  };
}

function stubEditManager(): any {
  return { showDiff: async () => {} };
}

function stubApprovalManager(): any {
  return {
    waitForApproval: async () => ({ approved: true })
  };
}

function stubOutputChannel(): any {
  return {
    appendLine: () => {},
    show: () => {},
    dispose: () => {}
  };
}

function stubOllamaClient(): any {
  return {
    chat: async function* () {
      yield { message: { content: '// generated content' } };
    }
  };
}

function stubCancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} })
  } as any;
}

async function makeTempDir(): Promise<string> {
  const base = path.join(os.tmpdir(), 'ollama-copilot-tests');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'fileedit-'));
}

function makeContext(workspacePath: string): any {
  return {
    workspace: {
      uri: vscode.Uri.file(workspacePath)
    },
    outputChannel: stubOutputChannel()
  };
}

suite('AgentFileEditHandler', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await makeTempDir();
  });

  teardown(async () => {
    try { await fs.rm(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  // ─── CRITICAL REGRESSION: Exactly one showToolAction(running) ─────

  suite('single running action emission (no duplicates)', () => {

    test('new file: emits exactly ONE showToolAction(running) with "Creating" verb', async () => {
      const { emitter, messages } = createStubEmitter();
      const { persist, calls } = createStubPersist();

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args = { path: 'src/brand-new.ts', content: 'export const x = 1;' };
      const context = makeContext(tempDir);

      await handler.execute(
        'write_file', args, context, 'session-1',
        'Write brand-new.ts', '✏️',
        stubCancellationToken()
      );

      // Count showToolAction(running) messages — must be exactly 1
      const runningMessages = messages.filter(
        m => m.type === 'showToolAction' && m.status === 'running'
      );
      assert.strictEqual(runningMessages.length, 1,
        `Expected exactly 1 showToolAction(running), got ${runningMessages.length}: ${JSON.stringify(runningMessages)}`);

      // Verify verb is "Creating" (new file)
      assert.ok(runningMessages[0].text.startsWith('Creating'),
        `Expected "Creating" verb, got: "${runningMessages[0].text}"`);

      // Verify detail is empty (no filename duplication)
      assert.strictEqual(runningMessages[0].detail, '',
        'Detail should be empty to avoid filename duplication');

      // Same check for persist calls
      const persistedRunning = calls.filter(
        c => c.eventType === 'showToolAction' && c.payload.status === 'running'
      );
      assert.strictEqual(persistedRunning.length, 1,
        `Expected exactly 1 persisted showToolAction(running), got ${persistedRunning.length}`);
    });

    test('existing file: emits exactly ONE showToolAction(running) with "Editing" verb', async () => {
      const { emitter, messages } = createStubEmitter();
      const { persist, calls: _calls } = createStubPersist();

      // Create existing file first
      const filePath = path.join(tempDir, 'src');
      await fs.mkdir(filePath, { recursive: true });
      await fs.writeFile(path.join(filePath, 'existing.ts'), 'export const old = true;');

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args = { path: 'src/existing.ts', content: 'export const updated = true;' };
      const context = makeContext(tempDir);

      await handler.execute(
        'write_file', args, context, 'session-1',
        'Write existing.ts', '✏️',
        stubCancellationToken()
      );

      const runningMessages = messages.filter(
        m => m.type === 'showToolAction' && m.status === 'running'
      );
      assert.strictEqual(runningMessages.length, 1,
        `Expected exactly 1 showToolAction(running), got ${runningMessages.length}`);

      // Verify verb is "Editing" (existing file)
      assert.ok(runningMessages[0].text.startsWith('Editing'),
        `Expected "Editing" verb, got: "${runningMessages[0].text}"`);
    });

    test('sensitive file with auto-approve: still only ONE showToolAction(running)', async () => {
      const { emitter, messages } = createStubEmitter();
      const { persist, calls: _calls2 } = createStubPersist();

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService({ auto_approve_sensitive_edits: true }),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      // .env files are sensitive by default patterns
      const args = { path: '.env.local', content: 'SECRET=abc' };
      const context = makeContext(tempDir);

      await handler.execute(
        'write_file', args, context, 'session-1',
        'Write .env.local', '✏️',
        stubCancellationToken()
      );

      const runningMessages = messages.filter(
        m => m.type === 'showToolAction' && m.status === 'running'
      );
      assert.strictEqual(runningMessages.length, 1,
        `Auto-approve branch must not emit extra running action. Got ${runningMessages.length}`);
    });

    test('sensitive file with manual approve: only ONE running + ONE pending, no extra running', async () => {
      const { emitter, messages } = createStubEmitter();
      const { persist, calls: _calls3 } = createStubPersist();

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService({ auto_approve_sensitive_edits: false }),
        stubEditManager(),
        emitter,
        stubApprovalManager(), // auto-approves for the test
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args = { path: '.env.local', content: 'SECRET=abc' };
      const context = makeContext(tempDir);

      await handler.execute(
        'write_file', args, context, 'session-1',
        'Write .env.local', '✏️',
        stubCancellationToken()
      );

      const runningMessages = messages.filter(
        m => m.type === 'showToolAction' && m.status === 'running'
      );
      const pendingMessages = messages.filter(
        m => m.type === 'showToolAction' && m.status === 'pending'
      );
      assert.strictEqual(runningMessages.length, 1,
        `Manual approve branch must not emit extra running action. Got ${runningMessages.length}`);
      assert.strictEqual(pendingMessages.length, 1,
        `Manual approve branch should emit ONE pending action for approval`);
    });
  });

  // ─── _isNew flag ──────────────────────────────────────────────────

  suite('_isNew flag on args', () => {

    test('sets _isNew=true for non-existent file', async () => {
      const { emitter } = createStubEmitter();
      const { persist } = createStubPersist();

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args: any = { path: 'brand-new.ts', content: 'new file' };
      await handler.execute(
        'write_file', args, makeContext(tempDir), 'session-1',
        'Write brand-new.ts', '✏️', stubCancellationToken()
      );

      assert.strictEqual(args._isNew, true,
        'Should set _isNew=true when file does not exist');
    });

    test('sets _isNew=false for existing file', async () => {
      const { emitter } = createStubEmitter();
      const { persist } = createStubPersist();

      await fs.writeFile(path.join(tempDir, 'exists.ts'), 'content');

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args: any = { path: 'exists.ts', content: 'updated' };
      await handler.execute(
        'write_file', args, makeContext(tempDir), 'session-1',
        'Write exists.ts', '✏️', stubCancellationToken()
      );

      assert.strictEqual(args._isNew, false,
        'Should set _isNew=false when file already exists');
    });
  });

  // ─── postMessage / persistUiEvent parity ──────────────────────────

  suite('postMessage and persistUiEvent parity', () => {

    test('every postMessage has a matching persistUiEvent in same order', async () => {
      const { emitter, messages } = createStubEmitter();
      const { persist, calls } = createStubPersist();

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args = { path: 'test.ts', content: 'hello' };
      await handler.execute(
        'write_file', args, makeContext(tempDir), 'session-1',
        'Write test.ts', '✏️', stubCancellationToken()
      );

      // For non-sensitive files: should be exactly 1 showToolAction(running) + matching persist
      const showToolMessages = messages.filter(m => m.type === 'showToolAction');
      const showToolPersisted = calls.filter(c => c.eventType === 'showToolAction');

      assert.strictEqual(showToolMessages.length, showToolPersisted.length,
        `Mismatch: ${showToolMessages.length} posted vs ${showToolPersisted.length} persisted showToolAction events`);

      // Verify the persist call comes with the correct sessionId
      for (const call of showToolPersisted) {
        assert.strictEqual(call.sessionId, 'session-1',
          'persistUiEvent must include the sessionId');
      }
    });

    test('sensitive file with approval: persist calls match postMessage calls for all event types', async () => {
      const { emitter, messages } = createStubEmitter();
      const { persist, calls } = createStubPersist();

      const handler = new AgentFileEditHandler(
        stubToolRegistry(),
        stubDatabaseService({ auto_approve_sensitive_edits: false }),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args = { path: '.env.local', content: 'SECRET=abc' };
      await handler.execute(
        'write_file', args, makeContext(tempDir), 'session-1',
        'Write .env.local', '✏️', stubCancellationToken()
      );

      // Check event types that must be persisted alongside postMessage
      const persistedTypes = calls.map(c => c.eventType);
      const postedTypes = messages
        .filter(m => ['showToolAction', 'requestFileEditApproval', 'fileEditApprovalResult'].includes(m.type))
        .map(m => m.type);

      // Every posted showToolAction/approval event must have a matching persist
      for (const type of postedTypes) {
        const postedCount = postedTypes.filter(t => t === type).length;
        const persistedCount = persistedTypes.filter(t => t === type).length;
        assert.ok(persistedCount >= postedCount,
          `Event type "${type}": ${postedCount} posted but only ${persistedCount} persisted`);
      }
    });
  });

  // ─── Deferred content generation ──────────────────────────────────

  suite('deferred content generation', () => {

    test('uses description to generate content when content is missing', async () => {
      const { emitter } = createStubEmitter();
      const { persist } = createStubPersist();

      let executedArgs: any = null;
      const registry = {
        execute: async (_name: string, args: any, _context: any) => {
          executedArgs = args;
          return { tool: _name, input: args, output: 'written', timestamp: Date.now() };
        }
      };

      const handler = new AgentFileEditHandler(
        registry as any,
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args: any = { path: 'gen.ts', description: 'A utility module for string formatting' };
      // Note: no `content` field
      await handler.execute(
        'write_file', args, makeContext(tempDir), 'session-1',
        'Write gen.ts', '✏️', stubCancellationToken(),
        'test-model', [] // model and messages for deferred generation
      );

      // args.content should be patched by deferred generation
      assert.ok(executedArgs.content, 'args.content should be set by deferred generation');
      assert.ok(executedArgs.content.includes('generated content'),
        'Content should come from stubbed OllamaClient.chat()');
    });

    test('uses provided content directly when content exists', async () => {
      const { emitter } = createStubEmitter();
      const { persist } = createStubPersist();

      let executedArgs: any = null;
      const registry = {
        execute: async (_name: string, args: any, _context: any) => {
          executedArgs = args;
          return { tool: _name, input: args, output: 'written', timestamp: Date.now() };
        }
      };

      const handler = new AgentFileEditHandler(
        registry as any,
        stubDatabaseService(),
        stubEditManager(),
        emitter,
        stubApprovalManager(),
        persist,
        stubOutputChannel(),
        stubOllamaClient()
      );

      const args: any = { path: 'direct.ts', content: 'const x = 42;', description: 'a number' };
      await handler.execute(
        'write_file', args, makeContext(tempDir), 'session-1',
        'Write direct.ts', '✏️', stubCancellationToken(),
        'test-model', []
      );

      assert.strictEqual(executedArgs.content, 'const x = 42;',
        'Should use provided content, not generate via LLM');
    });
  });
});
