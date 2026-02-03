import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionIndexService } from '../../../services/sessionIndexService';

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

    const svc = new SessionIndexService(context);
    await svc.initialize();

    const now = Date.now();
    const record = {
      id: 's1',
      title: 'Title',
      mode: 'ask',
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

    const svc = new SessionIndexService(context);
    await svc.initialize();

    const base = Date.now();
    for (let i = 0; i < 60; i++) {
      await svc.createSession({
        id: `s${i}`,
        title: `T${i}`,
        mode: 'ask',
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

    const svc = new SessionIndexService(context);
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
});
