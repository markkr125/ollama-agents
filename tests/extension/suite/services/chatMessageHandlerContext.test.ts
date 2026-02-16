import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewState, WebviewMessageEmitter } from '../../../../src/views/chatTypes';
import { ChatMessageHandler } from '../../../../src/views/messageHandlers/chatMessageHandler';

/**
 * Integration tests for ChatMessageHandler's multi-source context methods:
 *  - addContext (selection from active editor)
 *  - addContextCurrentFile (entire active file)
 *  - addContextFromTerminal (terminal buffer)
 *  - __implicit_file__ marker resolution
 *
 * Uses stub dependencies and captures postMessage calls.
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

function createStubViewState(): ViewState {
  return {
    currentMode: 'agent',
    currentModel: 'llama3',
    activeSessions: new Map()
  };
}

function createStubSessionController(): any {
  return {
    getCurrentSessionId: () => 'test-session-1',
    getCurrentSession: async () => ({ id: 'test-session-1', title: 'test', created_at: Date.now() }),
    getCurrentMessages: () => [],
    getSessionMessages: () => [],
    pushMessage: () => {},
    setSessionStatus: async () => {},
    sendSessionsList: async () => {},
    loadSessionMessages: async () => {},
  };
}

function createStubSettingsHandler(): any {
  return {
    sendSettingsUpdate: async () => {}
  };
}

function createStubAgentExecutor(): any {
  return {
    execute: async () => ({})
  };
}

function createStubDatabaseService(): any {
  return {
    addMessage: async () => ({ id: '1', session_id: 'test', role: 'user', text: '', timestamp: Date.now() }),
    getSession: async () => ({ id: 'test-session-1' }),
    updateSession: async () => {},
    persistUiEvent: async () => {}
  };
}

function createStubClient(): any {
  return {
    chat: async function* () { yield { message: { content: 'done' } }; },
    listModels: async () => ({ models: [] })
  };
}

function createStubTokenManager(): any {
  return { getToken: () => undefined };
}

function createStubSessionManager(): any {
  return {};
}

function createStubGitOps(): any {
  return {};
}

function createStubModelHandler(): any {
  return {
    handle: async () => {},
    handledTypes: ['refreshCapabilities'],
    getCapabilities: () => null
  };
}

function createHandler(emitter: WebviewMessageEmitter, state?: ViewState): ChatMessageHandler {
  return new ChatMessageHandler(
    state || createStubViewState(),
    emitter,
    createStubSessionController(),
    createStubSettingsHandler(),
    createStubAgentExecutor(),
    createStubDatabaseService(),
    createStubClient(),
    createStubTokenManager(),
    createStubSessionManager(),
    createStubGitOps(),
    createStubModelHandler(),
    undefined // reviewService
  );
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('ChatMessageHandler – context handlers', () => {

  /**
   * addContext: reads the active editor's selection (or full doc) and posts addContextItem.
   */
  test('addContext posts selection text from active editor', async () => {
    const tmpDir = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!tmpDir) return;

    const fileUri = vscode.Uri.joinPath(tmpDir, '.test-ctx-addcontext.ts');
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from('line1\nline2\nline3'));

    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 1, 5); // select "line1\nline2"

      const { emitter, messages } = createStubEmitter();
      const handler = createHandler(emitter);

      await handler.handle({ type: 'addContext' });

      const addMsg = messages.find(m => m.type === 'addContextItem');
      assert.ok(addMsg, 'should post addContextItem');
      assert.ok(addMsg!.context.content.includes('line1'), 'content should include selected text');
      // fileName should be the basename + line info
      assert.ok(addMsg!.context.fileName.includes('.test-ctx-addcontext.ts'), 'fileName should contain file name');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      try { await vscode.workspace.fs.delete(fileUri); } catch { /* ignore */ }
    }
  });

  /**
   * addContextCurrentFile: reads the ENTIRE active file (not just selection).
   */
  test('addContextCurrentFile posts entire file content', async () => {
    const tmpDir = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!tmpDir) return;

    const fileUri = vscode.Uri.joinPath(tmpDir, '.test-ctx-currentfile.ts');
    const fullContent = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fullContent));

    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);

      const { emitter, messages } = createStubEmitter();
      const handler = createHandler(emitter);

      await handler.handle({ type: 'addContextCurrentFile' });

      const addMsg = messages.find(m => m.type === 'addContextItem');
      assert.ok(addMsg, 'should post addContextItem');
      // Full content, not just selection
      assert.ok(addMsg!.context.content.includes('const a = 1;'), 'should include line 1');
      assert.ok(addMsg!.context.content.includes('const c = 3;'), 'should include line 3');
      assert.strictEqual(addMsg!.context.fileName, '.test-ctx-currentfile.ts');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      try { await vscode.workspace.fs.delete(fileUri); } catch { /* ignore */ }
    }
  });

  /**
   * addContextCurrentFile: no-op when no editor is active.
   */
  test('addContextCurrentFile does nothing when no editor open', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const { emitter, messages } = createStubEmitter();
    const handler = createHandler(emitter);

    await handler.handle({ type: 'addContextCurrentFile' });

    const addMsg = messages.find(m => m.type === 'addContextItem');
    assert.strictEqual(addMsg, undefined, 'should not post addContextItem without editor');
  });

  /**
   * addContextFromTerminal: posts terminal content (or fallback message).
   */
  test('addContextFromTerminal posts fallback when no active terminal', async () => {
    const { emitter, messages } = createStubEmitter();
    const handler = createHandler(emitter);

    await handler.handle({ type: 'addContextFromTerminal' });

    const addMsg = messages.find(m => m.type === 'addContextItem');
    assert.ok(addMsg, 'should post addContextItem');
    assert.ok(
      addMsg!.context.content.includes('No active terminal'),
      'should contain fallback message'
    );
  });
});

// ─── sendMessage contextFiles persistence tests ──────────────────────

suite('ChatMessageHandler – contextFiles in sendMessage', () => {
  /**
   * When sendMessage includes context items, the postMessage(addMessage) payload
   * should include a contextFiles array with fileName, kind, and lineRange.
   */
  test('addMessage postMessage includes contextFiles from context items', async () => {
    const { emitter, messages } = createStubEmitter();
    const state = createStubViewState();
    state.currentMode = 'chat'; // avoid agent mode path
    state.currentModel = 'test-model';
    const handler = createHandler(emitter, state);

    await handler.handle({
      type: 'sendMessage',
      text: 'Explain this code',
      context: [
        { fileName: 'src/app.ts', content: 'const x = 1;', kind: 'explicit' },
        { fileName: 'src/utils.ts', content: '__implicit_file__', kind: 'implicit-file' },
        { fileName: 'src/main.ts', content: 'selected text', kind: 'implicit-selection', lineRange: 'L5-L10' }
      ]
    });

    const addMsg = messages.find(m => m.type === 'addMessage');
    assert.ok(addMsg, 'should post addMessage');
    assert.ok(Array.isArray(addMsg!.contextFiles), 'contextFiles should be an array');
    assert.strictEqual(addMsg!.contextFiles.length, 3);
    assert.strictEqual(addMsg!.contextFiles[0].fileName, 'src/app.ts');
    assert.strictEqual(addMsg!.contextFiles[0].kind, 'explicit');
    assert.strictEqual(addMsg!.contextFiles[1].fileName, 'src/utils.ts');
    assert.strictEqual(addMsg!.contextFiles[1].kind, 'implicit-file');
    assert.strictEqual(addMsg!.contextFiles[2].fileName, 'src/main.ts');
    assert.strictEqual(addMsg!.contextFiles[2].lineRange, 'L5-L10');
  });

  /**
   * A __ui__ tool message with eventType='contextFiles' should be persisted
   * to the database so session history can reconstruct context file tags.
   */
  test('persists __ui__ contextFiles event to database', async () => {
    const { emitter } = createStubEmitter();
    const state = createStubViewState();
    state.currentMode = 'chat';
    state.currentModel = 'test-model';

    // Track addMessage calls to the database
    const dbCalls: any[] = [];
    const dbService = {
      ...createStubDatabaseService(),
      addMessage: async (...args: any[]) => {
        dbCalls.push(args);
        return { id: String(dbCalls.length), session_id: 'test-session-1', role: args[1], content: args[2] || '', timestamp: Date.now() };
      }
    };

    const handler = new ChatMessageHandler(
      state,
      emitter,
      createStubSessionController(),
      createStubSettingsHandler(),
      createStubAgentExecutor(),
      dbService,
      createStubClient(),
      createStubTokenManager(),
      createStubSessionManager(),
      createStubGitOps(),
      createStubModelHandler(),
      undefined
    );

    await handler.handle({
      type: 'sendMessage',
      text: 'Hello',
      context: [
        { fileName: 'readme.md', content: 'docs', kind: 'explicit' }
      ]
    });

    // Find the __ui__ tool message call
    const uiCall = dbCalls.find(call =>
      call[1] === 'tool' && call[3]?.toolName === '__ui__'
    );
    assert.ok(uiCall, 'should persist a __ui__ tool message');

    const toolOutput = JSON.parse(uiCall[3].toolOutput);
    assert.strictEqual(toolOutput.eventType, 'contextFiles');
    assert.ok(Array.isArray(toolOutput.payload.files));
    assert.strictEqual(toolOutput.payload.files[0].fileName, 'readme.md');
    assert.strictEqual(toolOutput.payload.files[0].kind, 'explicit');
  });

  /**
   * When sendMessage has no context items, no contextFiles should be in addMessage
   * and no __ui__ contextFiles event should be persisted.
   */
  test('no contextFiles when sendMessage has no context', async () => {
    const { emitter, messages } = createStubEmitter();
    const state = createStubViewState();
    state.currentMode = 'chat';
    state.currentModel = 'test-model';

    const dbCalls: any[] = [];
    const dbService = {
      ...createStubDatabaseService(),
      addMessage: async (...args: any[]) => {
        dbCalls.push(args);
        return { id: String(dbCalls.length), session_id: 'test-session-1', role: args[1], content: args[2] || '', timestamp: Date.now() };
      }
    };

    const handler = new ChatMessageHandler(
      state,
      emitter,
      createStubSessionController(),
      createStubSettingsHandler(),
      createStubAgentExecutor(),
      dbService,
      createStubClient(),
      createStubTokenManager(),
      createStubSessionManager(),
      createStubGitOps(),
      createStubModelHandler(),
      undefined
    );

    await handler.handle({
      type: 'sendMessage',
      text: 'Hello'
    });

    const addMsg = messages.find(m => m.type === 'addMessage');
    assert.ok(addMsg, 'should post addMessage');
    // contextFiles should be empty array (no context items)
    assert.ok(Array.isArray(addMsg!.contextFiles), 'contextFiles should still be an array');
    assert.strictEqual(addMsg!.contextFiles.length, 0);

    // No __ui__ tool message should be persisted
    const uiCall = dbCalls.find(call =>
      call[1] === 'tool' && call[3]?.toolName === '__ui__'
    );
    assert.strictEqual(uiCall, undefined, 'should NOT persist __ui__ event when no context files');
  });
});
