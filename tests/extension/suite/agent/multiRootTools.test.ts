import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolContext, ToolRegistry } from '../../../../src/agent/toolRegistry';

/**
 * Tests that verify agent tools work correctly in a multi-root workspace.
 * Creates two workspace folders ("frontend" and "backend") and verifies
 * that tools can resolve files across both folders.
 */

suite('Multi-Root Workspace Tools', () => {
  let toolRegistry: ToolRegistry;
  let baseDir: string;
  let frontendDir: string;
  let backendDir: string;
  let primaryFolder: vscode.WorkspaceFolder;
  let secondaryFolder: vscode.WorkspaceFolder;
  let allFolders: vscode.WorkspaceFolder[];
  let context: ToolContext;
  let outputChannel: vscode.OutputChannel;

  suiteSetup(() => {
    baseDir = path.join(os.tmpdir(), `ollama-copilot-multiroot-tool-test-${Date.now()}`);
    frontendDir = path.join(baseDir, 'frontend');
    backendDir = path.join(baseDir, 'backend');

    fs.mkdirSync(frontendDir, { recursive: true });
    fs.mkdirSync(backendDir, { recursive: true });

    // ─── Frontend workspace files ─────────────────────────────────
    fs.mkdirSync(path.join(frontendDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(frontendDir, 'src', 'app.ts'),
      'export function renderApp(): string {\n  return "frontend";\n}\n'
    );
    fs.writeFileSync(
      path.join(frontendDir, 'README.md'),
      '# Frontend\nFrontend project\n'
    );
    fs.writeFileSync(
      path.join(frontendDir, 'tsconfig.json'),
      '{ "compilerOptions": { "target": "ES2020" } }\n'
    );

    // ─── Backend workspace files ──────────────────────────────────
    fs.mkdirSync(path.join(backendDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(backendDir, 'src', 'server.ts'),
      '// TODO: add routes\nexport function startServer(): void {\n  console.log("backend");\n}\n'
    );
    fs.writeFileSync(
      path.join(backendDir, 'package.json'),
      '{ "name": "backend", "version": "1.0.0" }\n'
    );

    // ─── Shared file (exists in both) ─────────────────────────────
    fs.writeFileSync(
      path.join(frontendDir, 'shared.txt'),
      'shared-in-frontend\n'
    );
    fs.writeFileSync(
      path.join(backendDir, 'shared.txt'),
      'shared-in-backend\n'
    );

    primaryFolder = {
      uri: vscode.Uri.file(frontendDir),
      name: 'frontend',
      index: 0,
    };
    secondaryFolder = {
      uri: vscode.Uri.file(backendDir),
      name: 'backend',
      index: 1,
    };
    allFolders = [primaryFolder, secondaryFolder];

    outputChannel = vscode.window.createOutputChannel('Multi-Root Test');

    context = {
      workspace: primaryFolder,
      workspaceFolders: allFolders,
      token: new vscode.CancellationTokenSource().token,
      outputChannel,
    };

    toolRegistry = new ToolRegistry();
    toolRegistry.registerBuiltInTools();
  });

  suiteTeardown(() => {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
    outputChannel.dispose();
  });

  // ─── read_file ─────────────────────────────────────────────────────

  suite('read_file', () => {
    test('reads file from primary workspace by relative path', async () => {
      const result = await toolRegistry.execute('read_file', {
        path: 'src/app.ts',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('renderApp'));
    });

    test('reads file from secondary workspace by relative path', async () => {
      const result = await toolRegistry.execute('read_file', {
        path: 'src/server.ts',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('startServer'));
    });

    test('reads file using folder-name prefix (backend/src/server.ts)', async () => {
      const result = await toolRegistry.execute('read_file', {
        path: 'backend/src/server.ts',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('startServer'));
    });

    test('reads file from secondary by unique path (package.json)', async () => {
      const result = await toolRegistry.execute('read_file', {
        path: 'package.json',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('"backend"'));
    });

    test('reads file from primary when it exists in both folders', async () => {
      const result = await toolRegistry.execute('read_file', {
        path: 'shared.txt',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('shared-in-frontend'), 'Primary should win');
    });

    test('reads file by absolute path regardless of workspace', async () => {
      const absPath = path.join(backendDir, 'src', 'server.ts');
      const result = await toolRegistry.execute('read_file', {
        path: absPath,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('startServer'));
    });
  });

  // ─── list_files ────────────────────────────────────────────────────

  suite('list_files', () => {
    test('lists all workspace roots when path is empty (multi-root)', async () => {
      const result = await toolRegistry.execute('list_files', {}, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      const output = result.output || '';
      assert.ok(output.includes('frontend'), 'Should list frontend folder');
      assert.ok(output.includes('backend'), 'Should list backend folder');
    });

    test('lists files in secondary workspace via folder-name prefix', async () => {
      const result = await toolRegistry.execute('list_files', {
        path: 'backend/src',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('server.ts'));
    });

    test('lists files in primary workspace src/', async () => {
      const result = await toolRegistry.execute('list_files', {
        path: 'src',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('app.ts'));
    });
  });

  // ─── write_file ────────────────────────────────────────────────────

  suite('write_file', () => {
    test('writes new file in primary workspace by default', async () => {
      const result = await toolRegistry.execute('write_file', {
        path: 'new-file.txt',
        content: 'created in frontend',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // File should exist in primary (frontend)
      const filePath = path.join(frontendDir, 'new-file.txt');
      assert.ok(fs.existsSync(filePath), 'File should be in primary workspace');
      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'created in frontend');

      // Clean up
      fs.unlinkSync(filePath);
    });

    test('overwrites file in correct workspace folder', async () => {
      const result = await toolRegistry.execute('write_file', {
        path: 'package.json',
        content: '{ "name": "updated-backend" }',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // package.json only exists in backend — should update there
      const content = fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8');
      assert.ok(content.includes('updated-backend'));

      // Restore original
      fs.writeFileSync(
        path.join(backendDir, 'package.json'),
        '{ "name": "backend", "version": "1.0.0" }\n'
      );
    });
  });

  // ─── search_workspace ──────────────────────────────────────────────

  suite('search_workspace', () => {
    test('finds matches across both workspace folders', async () => {
      const result = await toolRegistry.execute('search_workspace', {
        query: 'TODO',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // "TODO: add routes" is in backend/src/server.ts
      assert.ok(result.output?.includes('TODO'), 'Should find TODO in backend');
    });

    test('finds text unique to secondary folder', async () => {
      const result = await toolRegistry.execute('search_workspace', {
        query: 'startServer',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('startServer'));
    });

    test('finds text unique to primary folder', async () => {
      const result = await toolRegistry.execute('search_workspace', {
        query: 'renderApp',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('renderApp'));
    });
  });

  // ─── get_diagnostics ──────────────────────────────────────────────

  suite('get_diagnostics', () => {
    test('accepts path from secondary folder', async () => {
      const result = await toolRegistry.execute('get_diagnostics', {
        path: 'src/server.ts',
      }, context);

      // May have diagnostics or not — just ensure no crash
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output);
    });

    test('accepts folder-name prefixed path', async () => {
      const result = await toolRegistry.execute('get_diagnostics', {
        path: 'backend/src/server.ts',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output);
    });
  });
});
