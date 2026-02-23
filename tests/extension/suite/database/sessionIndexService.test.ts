import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionIndexService } from '../../../../src/services/database/sessionIndexService';

function getExtensionUri(): vscode.Uri {
  const ext = vscode.extensions.getExtension('ollama-copilot.ollama-copilot');
  assert.ok(ext, 'Expected development extension to be available');
  return ext.extensionUri;
}

async function makeTempDir(prefix: string): Promise<string> {
  const base = path.join(os.tmpdir(), 'ollama-copilot-tests');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, `${prefix}-`));
}

function makeFakeContext(storagePath: string): vscode.ExtensionContext {
  const storageUri = vscode.Uri.file(storagePath);

  return {
    extensionUri: getExtensionUri(),
    storageUri,
    globalStorageUri: storageUri,
    subscriptions: []
  } as any;
}

suite('SessionIndexService', () => {
  test('createSession/getSession/updateSession roundtrip', async () => {
    const dir = await makeTempDir('sessions-rt');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const now = Date.now();
    const record = {
      id: 's1',
      title: 'Title',
      mode: 'chat',
      model: 'test-model',
      status: 'idle' as const,
      auto_approve_commands: false,
      created_at: now,
      updated_at: now
    };

    await svc.createSession(record);
    const loaded = await svc.getSession('s1');
    assert.ok(loaded);
    assert.strictEqual(loaded!.title, 'Title');
    assert.strictEqual(loaded!.auto_approve_commands, false);

    await svc.updateSession('s1', { title: 'Title 2', auto_approve_commands: true });
    const updated = await svc.getSession('s1');
    assert.ok(updated);
    assert.strictEqual(updated!.title, 'Title 2');
    assert.strictEqual(updated!.auto_approve_commands, true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('listSessions pagination and ordering by updated_at desc', async () => {
    const dir = await makeTempDir('sessions-page');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const base = Date.now();
    for (let i = 0; i < 60; i++) {
      await svc.createSession({
        id: `s${i}`,
        title: `T${i}`,
        mode: 'chat',
        model: 'test-model',
        status: 'completed' as const,
        auto_approve_commands: false,
        created_at: base + i,
        updated_at: base + i
      });
    }

    const page1 = await svc.listSessions(50, 0);
    assert.strictEqual(page1.sessions.length, 50);
    assert.strictEqual(page1.hasMore, true);
    assert.strictEqual(page1.nextOffset, 50);

    // Most recently updated should come first
    assert.strictEqual(page1.sessions[0].id, 's59');
    assert.strictEqual(page1.sessions[49].id, 's10');

    const page2 = await svc.listSessions(50, page1.nextOffset!);
    assert.strictEqual(page2.sessions.length, 10);
    assert.strictEqual(page2.hasMore, false);
    assert.strictEqual(page2.nextOffset, null);
    assert.strictEqual(page2.sessions[0].id, 's9');
    assert.strictEqual(page2.sessions[9].id, 's0');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('resetGeneratingSessions sets generating -> idle', async () => {
    const dir = await makeTempDir('sessions-reset');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const now = Date.now();
    await svc.createSession({
      id: 'gen',
      title: 'Gen',
      mode: 'agent',
      model: 'test-model',
      status: 'generating' as any,
      auto_approve_commands: false,
      created_at: now,
      updated_at: now
    });

    await svc.resetGeneratingSessions('idle');
    const loaded = await svc.getSession('gen');
    assert.ok(loaded);
    assert.strictEqual(loaded!.status, 'idle');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('addMessage / getMessagesBySession roundtrip', async () => {
    const dir = await makeTempDir('sessions-msg');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const now = Date.now();
    await svc.createSession({
      id: 's1', title: 'T', mode: 'chat', model: 'm',
      status: 'idle', auto_approve_commands: false,
      created_at: now, updated_at: now
    });

    await svc.addMessage({
      id: 'm1', session_id: 's1', role: 'user', content: 'Hello',
      timestamp: now
    });
    await svc.addMessage({
      id: 'm2', session_id: 's1', role: 'assistant', content: 'World',
      model: 'test-model', timestamp: now + 1
    });
    await svc.addMessage({
      id: 'm3', session_id: 's1', role: 'tool', content: '',
      tool_name: 'read_file', tool_input: '{"path":"x.ts"}',
      tool_output: 'contents', timestamp: now + 2
    });

    const messages = await svc.getMessagesBySession('s1');
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].id, 'm1');
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content, 'Hello');
    assert.strictEqual(messages[1].model, 'test-model');
    assert.strictEqual(messages[2].tool_name, 'read_file');
    assert.strictEqual(messages[2].tool_output, 'contents');

    // Messages ordered by timestamp
    for (let i = 1; i < messages.length; i++) {
      assert.ok(messages[i].timestamp > messages[i - 1].timestamp);
    }

    await svc.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('getNextTimestamp returns strictly increasing values', async () => {
    const dir = await makeTempDir('sessions-ts');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const now = Date.now();
    await svc.createSession({
      id: 's1', title: 'T', mode: 'chat', model: 'm',
      status: 'idle', auto_approve_commands: false,
      created_at: now, updated_at: now
    });

    const timestamps: number[] = [];
    for (let i = 0; i < 10; i++) {
      timestamps.push(await svc.getNextTimestamp('s1'));
    }

    for (let i = 1; i < timestamps.length; i++) {
      assert.ok(timestamps[i] > timestamps[i - 1],
        `Timestamp ${i} (${timestamps[i]}) must be > timestamp ${i - 1} (${timestamps[i - 1]})`);
    }

    await svc.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('FK constraint prevents adding message to non-existent session', async () => {
    const dir = await makeTempDir('sessions-fk');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    let threw = false;
    try {
      await svc.addMessage({
        id: 'm1', session_id: 'no-such-session', role: 'user',
        content: 'orphan', timestamp: Date.now()
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'Expected FK constraint to reject orphan message');

    await svc.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('deleteSession cascades to messages', async () => {
    const dir = await makeTempDir('sessions-cascade');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const now = Date.now();
    await svc.createSession({
      id: 's1', title: 'T', mode: 'chat', model: 'm',
      status: 'idle', auto_approve_commands: false,
      created_at: now, updated_at: now
    });

    await svc.addMessage({ id: 'm1', session_id: 's1', role: 'user', content: 'hi', timestamp: now });
    await svc.addMessage({ id: 'm2', session_id: 's1', role: 'assistant', content: 'hey', timestamp: now + 1 });

    assert.strictEqual((await svc.getMessagesBySession('s1')).length, 2);

    await svc.deleteSession('s1');

    assert.strictEqual(await svc.getSession('s1'), null);
    assert.strictEqual((await svc.getMessagesBySession('s1')).length, 0);

    await svc.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('clearAllSessions removes all sessions and cascades messages', async () => {
    const dir = await makeTempDir('sessions-clear');
    const context = makeFakeContext(dir);

    const svc = new SessionIndexService(context.storageUri!);
    await svc.initialize();

    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await svc.createSession({
        id: `s${i}`, title: `T${i}`, mode: 'chat', model: 'm',
        status: 'idle', auto_approve_commands: false,
        created_at: now + i, updated_at: now + i
      });
      await svc.addMessage({ id: `m${i}`, session_id: `s${i}`, role: 'user', content: `msg${i}`, timestamp: now + i });
    }

    const before = await svc.listSessions(50, 0);
    assert.strictEqual(before.sessions.length, 3);

    await svc.clearAllSessions();

    const after = await svc.listSessions(50, 0);
    assert.strictEqual(after.sessions.length, 0);

    // Messages should be gone via CASCADE
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await svc.getMessagesBySession(`s${i}`)).length, 0);
    }

    await svc.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
