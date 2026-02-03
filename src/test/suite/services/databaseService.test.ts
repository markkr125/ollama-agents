import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from '../../../services/databaseService';

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

suite('DatabaseService', () => {
  test('addMessage() timestamps are strictly increasing and persist across restart', async () => {
    const dir = await makeTempDir('db-ts');
    const context = makeFakeContext(dir);

    const db1 = new DatabaseService(context);
    await db1.initialize();

    const session = await db1.createSession('t', 'ask', 'test-model');

    for (let i = 0; i < 8; i++) {
      await db1.addMessage(session.id, 'user', `m${i}`);
    }

    const before = await db1.getSessionMessages(session.id);
    assert.strictEqual(before.length, 8);

    for (let i = 1; i < before.length; i++) {
      assert.ok(before[i].timestamp > before[i - 1].timestamp);
    }

    const maxBefore = before[before.length - 1].timestamp;
    await db1.close();

    // New instance using same storage simulates extension restart
    const db2 = new DatabaseService(context);
    await db2.initialize();

    await db2.addMessage(session.id, 'assistant', 'after-restart');
    const after = await db2.getSessionMessages(session.id);

    assert.strictEqual(after.length, 9);
    assert.ok(after[after.length - 1].timestamp > maxBefore);

    await db2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('runMaintenance() deletes orphan messages but never deletes sessions', async () => {
    const dir = await makeTempDir('db-maint');
    const context = makeFakeContext(dir);

    const db = new DatabaseService(context);
    await db.initialize();

    const session = await db.createSession('keep-me', 'ask', 'test-model');

    // Orphan message: session id not present in SQLite
    await db.addMessage('orphan-session', 'user', 'orphan');
    const orphanBefore = await db.getSessionMessages('orphan-session');
    assert.strictEqual(orphanBefore.length, 1);

    const result = await db.runMaintenance();
    assert.strictEqual(result.deletedSessions, 0);
    assert.strictEqual(result.deletedMessages, 1);

    const orphanAfter = await db.getSessionMessages('orphan-session');
    assert.strictEqual(orphanAfter.length, 0);

    // Session should still exist even with zero messages
    const stillThere = await db.getSession(session.id);
    assert.ok(stillThere);

    const sessionsPage = await db.listSessions(50, 0);
    assert.ok(sessionsPage.sessions.some(s => s.id === session.id));

    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
