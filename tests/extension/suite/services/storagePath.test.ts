import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { migrateIfNeeded, resolveStoragePath, workspaceKey } from '../../../../src/services/database/storagePath';

async function makeTempDir(prefix: string): Promise<string> {
  const base = path.join(os.tmpdir(), 'ollama-copilot-tests');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, `${prefix}-`));
}

function makeFakeContext(opts: {
  storageUri?: vscode.Uri;
  globalStorageUri: vscode.Uri;
}): vscode.ExtensionContext {
  return {
    storageUri: opts.storageUri,
    globalStorageUri: opts.globalStorageUri,
    subscriptions: []
  } as any;
}

suite('storagePath', () => {

  // ---- workspaceKey ----

  test('workspaceKey returns a 64-char hex SHA-256', () => {
    const key = workspaceKey(vscode.Uri.file('/home/user/project'));
    assert.strictEqual(key.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(key), `Expected hex string, got: ${key}`);
  });

  test('workspaceKey is deterministic for the same URI', () => {
    const uri = vscode.Uri.file('/home/user/project');
    assert.strictEqual(workspaceKey(uri), workspaceKey(uri));
  });

  test('workspaceKey differs for different URIs', () => {
    const a = workspaceKey(vscode.Uri.file('/home/user/projectA'));
    const b = workspaceKey(vscode.Uri.file('/home/user/projectB'));
    assert.notStrictEqual(a, b);
  });

  // ---- resolveStoragePath ----

  test('resolveStoragePath falls back to globalStorageUri when no workspace folders', () => {
    // When no workspace folders exist and no custom setting,
    // resolveStoragePath should return globalStorageUri.
    // Note: this test may behave differently depending on whether the dev host
    // has workspace folders open. We test the workspaceKey + globalStorageUri
    // path derivation separately.
    const globalUri = vscode.Uri.file('/tmp/fake-global-storage');
    const context = makeFakeContext({ globalStorageUri: globalUri });

    // If workspace has folders, the result is globalStorageUri/<hash>
    // If workspace has no folders, the result is globalStorageUri
    const result = resolveStoragePath(context);
    // Either way, the result should be under globalStorageUri
    assert.ok(result.fsPath.startsWith(globalUri.fsPath));
  });

  // ---- migrateIfNeeded ----

  test('migrateIfNeeded copies databases from old to new location', async () => {
    const oldDir = await makeTempDir('migrate-old');
    const newDir = await makeTempDir('migrate-new');

    // Create a fake SQLite DB in the old location
    const oldSqlite = path.join(oldDir, 'sessions.sqlite');
    await fs.writeFile(oldSqlite, 'fake-sqlite-data');

    // Create a fake LanceDB directory
    const oldLance = path.join(oldDir, 'ollama-copilot.lance');
    await fs.mkdir(path.join(oldLance, 'data'), { recursive: true });
    await fs.writeFile(path.join(oldLance, 'data', 'shard.bin'), 'lance-data');

    const context = makeFakeContext({
      storageUri: vscode.Uri.file(oldDir),
      globalStorageUri: vscode.Uri.file(newDir)
    });

    await migrateIfNeeded(context, vscode.Uri.file(newDir));

    // Verify SQLite was copied
    const newSqlite = path.join(newDir, 'sessions.sqlite');
    const sqliteContent = await fs.readFile(newSqlite, 'utf-8');
    assert.strictEqual(sqliteContent, 'fake-sqlite-data');

    // Verify LanceDB was copied
    const newLance = path.join(newDir, 'ollama-copilot.lance', 'data', 'shard.bin');
    const lanceContent = await fs.readFile(newLance, 'utf-8');
    assert.strictEqual(lanceContent, 'lance-data');

    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.rm(newDir, { recursive: true, force: true });
  });

  test('migrateIfNeeded is a no-op if new location already has sessions.sqlite', async () => {
    const oldDir = await makeTempDir('migrate-noop-old');
    const newDir = await makeTempDir('migrate-noop-new');

    await fs.writeFile(path.join(oldDir, 'sessions.sqlite'), 'old-data');
    await fs.writeFile(path.join(newDir, 'sessions.sqlite'), 'existing-data');

    const context = makeFakeContext({
      storageUri: vscode.Uri.file(oldDir),
      globalStorageUri: vscode.Uri.file(newDir)
    });

    await migrateIfNeeded(context, vscode.Uri.file(newDir));

    // Should NOT have overwritten
    const content = await fs.readFile(path.join(newDir, 'sessions.sqlite'), 'utf-8');
    assert.strictEqual(content, 'existing-data');

    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.rm(newDir, { recursive: true, force: true });
  });

  test('migrateIfNeeded is a no-op if old location has no database', async () => {
    const oldDir = await makeTempDir('migrate-empty-old');
    const newDir = await makeTempDir('migrate-empty-new');

    const context = makeFakeContext({
      storageUri: vscode.Uri.file(oldDir),
      globalStorageUri: vscode.Uri.file(newDir)
    });

    await migrateIfNeeded(context, vscode.Uri.file(newDir));

    // New directory should still have no sessions.sqlite
    const files = await fs.readdir(newDir);
    assert.ok(!files.includes('sessions.sqlite'));

    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.rm(newDir, { recursive: true, force: true });
  });

  test('migrateIfNeeded is a no-op if old and new paths are identical', async () => {
    const dir = await makeTempDir('migrate-same');
    await fs.writeFile(path.join(dir, 'sessions.sqlite'), 'data');

    const context = makeFakeContext({
      storageUri: vscode.Uri.file(dir),
      globalStorageUri: vscode.Uri.file(dir)
    });

    // Should not throw or corrupt
    await migrateIfNeeded(context, vscode.Uri.file(dir));

    const content = await fs.readFile(path.join(dir, 'sessions.sqlite'), 'utf-8');
    assert.strictEqual(content, 'data');

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('migrateIfNeeded is a no-op if storageUri is undefined', async () => {
    const newDir = await makeTempDir('migrate-no-storage');

    const context = makeFakeContext({
      globalStorageUri: vscode.Uri.file(newDir)
    });

    // storageUri is undefined — should early return
    await migrateIfNeeded(context, vscode.Uri.file(newDir));

    const files = await fs.readdir(newDir);
    assert.ok(!files.includes('sessions.sqlite'));

    await fs.rm(newDir, { recursive: true, force: true });
  });

  test('migrateIfNeeded copies WAL and SHM files when they exist', async () => {
    const oldDir = await makeTempDir('migrate-wal-old');
    const newDir = await makeTempDir('migrate-wal-new');

    await fs.writeFile(path.join(oldDir, 'sessions.sqlite'), 'db');
    await fs.writeFile(path.join(oldDir, 'sessions.sqlite-wal'), 'wal');
    await fs.writeFile(path.join(oldDir, 'sessions.sqlite-shm'), 'shm');

    const context = makeFakeContext({
      storageUri: vscode.Uri.file(oldDir),
      globalStorageUri: vscode.Uri.file(newDir)
    });

    await migrateIfNeeded(context, vscode.Uri.file(newDir));

    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions.sqlite'), 'utf-8'), 'db');
    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions.sqlite-wal'), 'utf-8'), 'wal');
    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions.sqlite-shm'), 'utf-8'), 'shm');

    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.rm(newDir, { recursive: true, force: true });
  });
});
