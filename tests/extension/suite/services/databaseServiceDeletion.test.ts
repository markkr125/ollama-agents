import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from '../../../../src/services/databaseService';

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

suite('DatabaseService deletion', () => {
  test('deleteSession removes session and its messages', async () => {
    const dir = await makeTempDir('db-del');
    const context = makeFakeContext(dir);

    const db = new DatabaseService(context);
    await db.initialize();

    const session = await db.createSession('to-delete', 'ask', 'test-model');
    await db.addMessage(session.id, 'user', 'hi');
    await db.addMessage(session.id, 'assistant', 'hello');

    const before = await db.getSessionMessages(session.id);
    assert.strictEqual(before.length, 2);

    await db.deleteSession(session.id);

    const sessionAfter = await db.getSession(session.id);
    assert.strictEqual(sessionAfter, null);

    const messagesAfter = await db.getSessionMessages(session.id);
    assert.strictEqual(messagesAfter.length, 0);

    await db.close();
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* LanceDB may hold file locks */ }
  });
});
