import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveMultiRootPath, resolveWorkspacePath } from '../../../../src/agent/tools/pathUtils';

/**
 * Helper: create a mock WorkspaceFolder pointing at the given directory.
 */
function makeFolder(fsPath: string, name: string, index: number): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(fsPath), name, index };
}

// ─── resolveWorkspacePath (single-root, original helper) ─────────────

suite('resolveWorkspacePath', () => {
  let testDir: string;
  let workspace: vscode.WorkspaceFolder;

  suiteSetup(() => {
    testDir = path.join(os.tmpdir(), `ollama-copilot-pathutils-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    workspace = makeFolder(testDir, 'primary', 0);
  });

  suiteTeardown(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('joins relative path to workspace root', () => {
    const result = resolveWorkspacePath('src/index.ts', workspace);
    assert.strictEqual(result, path.join(testDir, 'src/index.ts'));
  });

  test('returns absolute path as-is', () => {
    const abs = '/absolute/path/file.ts';
    assert.strictEqual(resolveWorkspacePath(abs, workspace), abs);
  });
});

// ─── resolveMultiRootPath ────────────────────────────────────────────

suite('resolveMultiRootPath', () => {
  let primaryDir: string;
  let secondaryDir: string;
  let tertiaryDir: string;
  let primary: vscode.WorkspaceFolder;
  let secondary: vscode.WorkspaceFolder;
  let tertiary: vscode.WorkspaceFolder;
  let allFolders: vscode.WorkspaceFolder[];

  suiteSetup(() => {
    const base = path.join(os.tmpdir(), `ollama-copilot-multiroot-test-${Date.now()}`);
    fs.mkdirSync(base, { recursive: true });

    primaryDir = path.join(base, 'frontend');
    secondaryDir = path.join(base, 'backend');
    tertiaryDir = path.join(base, 'shared');
    fs.mkdirSync(primaryDir, { recursive: true });
    fs.mkdirSync(secondaryDir, { recursive: true });
    fs.mkdirSync(tertiaryDir, { recursive: true });

    primary = makeFolder(primaryDir, 'frontend', 0);
    secondary = makeFolder(secondaryDir, 'backend', 1);
    tertiary = makeFolder(tertiaryDir, 'shared', 2);
    allFolders = [primary, secondary, tertiary];

    // Create files for resolution tests
    // Primary files
    fs.mkdirSync(path.join(primaryDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(primaryDir, 'src', 'app.ts'), '// frontend app');
    fs.writeFileSync(path.join(primaryDir, 'README.md'), '# frontend');

    // Secondary files (only in backend)
    fs.mkdirSync(path.join(secondaryDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(secondaryDir, 'src', 'server.ts'), '// backend server');
    fs.writeFileSync(path.join(secondaryDir, 'package.json'), '{}');

    // Tertiary files (only in shared)
    fs.mkdirSync(path.join(tertiaryDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tertiaryDir, 'lib', 'utils.ts'), '// shared utils');

    // File that exists in BOTH primary and secondary
    fs.writeFileSync(path.join(primaryDir, 'tsconfig.json'), '{"primary": true}');
    fs.writeFileSync(path.join(secondaryDir, 'tsconfig.json'), '{"secondary": true}');
  });

  suiteTeardown(() => {
    const base = path.dirname(primaryDir);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── Absolute paths ─────────────────────────────────────────────

  test('returns absolute path as-is', () => {
    const abs = '/some/absolute/path.ts';
    assert.strictEqual(resolveMultiRootPath(abs, primary, allFolders), abs);
  });

  // ─── Single-root fast path ──────────────────────────────────────

  test('behaves like resolveWorkspacePath when allFolders is undefined', () => {
    const result = resolveMultiRootPath('src/app.ts', primary);
    assert.strictEqual(result, path.join(primaryDir, 'src/app.ts'));
  });

  test('behaves like resolveWorkspacePath when allFolders has 1 entry', () => {
    const result = resolveMultiRootPath('src/app.ts', primary, [primary]);
    assert.strictEqual(result, path.join(primaryDir, 'src/app.ts'));
  });

  test('strips folder-name prefix in single-root mode (search result format)', () => {
    // vscode.workspace.asRelativePath(file, true) returns "frontend/src/app.ts"
    // even in single-root — resolveMultiRootPath must strip that prefix
    const result = resolveMultiRootPath('frontend/src/app.ts', primary);
    assert.strictEqual(result, path.join(primaryDir, 'src/app.ts'));
  });

  test('resolves bare folder name to workspace root in single-root mode', () => {
    // LLMs sometimes call list_files(path="myproject") — should resolve to root,
    // not root/myproject (doubled path)
    const result = resolveMultiRootPath('frontend', primary);
    assert.strictEqual(result, primaryDir);
  });

  test('does not strip folder-name prefix when it is a real subdirectory', () => {
    // If "frontend/" is actually a subdirectory inside primary, don't strip
    const subdir = path.join(primaryDir, 'frontend', 'nested');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'real.ts'), '// nested');
    const result = resolveMultiRootPath('frontend/nested/real.ts', primary);
    assert.strictEqual(result, path.join(primaryDir, 'frontend/nested/real.ts'));
    // Clean up
    fs.rmSync(path.join(primaryDir, 'frontend'), { recursive: true, force: true });
  });

  // ─── Primary folder resolution ─────────────────────────────────

  test('resolves file from primary workspace when it exists there', () => {
    const result = resolveMultiRootPath('src/app.ts', primary, allFolders);
    assert.strictEqual(result, path.join(primaryDir, 'src/app.ts'));
  });

  test('when file exists in both primary and secondary, primary wins', () => {
    const result = resolveMultiRootPath('tsconfig.json', primary, allFolders);
    assert.strictEqual(result, path.join(primaryDir, 'tsconfig.json'));
  });

  // ─── Secondary folder resolution ───────────────────────────────

  test('resolves file from secondary workspace when not in primary', () => {
    const result = resolveMultiRootPath('src/server.ts', primary, allFolders);
    assert.strictEqual(result, path.join(secondaryDir, 'src/server.ts'));
  });

  test('resolves file from secondary by unique file', () => {
    const result = resolveMultiRootPath('package.json', primary, allFolders);
    assert.strictEqual(result, path.join(secondaryDir, 'package.json'));
  });

  // ─── Tertiary folder resolution ────────────────────────────────

  test('resolves file from tertiary workspace', () => {
    const result = resolveMultiRootPath('lib/utils.ts', primary, allFolders);
    assert.strictEqual(result, path.join(tertiaryDir, 'lib/utils.ts'));
  });

  // ─── Folder-name prefix resolution ─────────────────────────────

  test('resolves folderName/path pattern (e.g. "backend/src/server.ts")', () => {
    const result = resolveMultiRootPath('backend/src/server.ts', primary, allFolders);
    assert.strictEqual(result, path.join(secondaryDir, 'src/server.ts'));
  });

  test('resolves folderName/path for shared folder', () => {
    const result = resolveMultiRootPath('shared/lib/utils.ts', primary, allFolders);
    assert.strictEqual(result, path.join(tertiaryDir, 'lib/utils.ts'));
  });

  test('folderName prefix does not match if file does not exist there', () => {
    // "backend/src/app.ts" does not exist under secondaryDir
    const result = resolveMultiRootPath('backend/src/app.ts', primary, allFolders);
    // Should fall back to primary workspace (new file path)
    assert.strictEqual(result, path.join(primaryDir, 'backend/src/app.ts'));
  });

  // ─── Bare folder name resolution (single segment) ──────────────

  test('resolves bare folder name to workspace folder root', () => {
    // LLMs call list_files(path="backend") — should resolve to backend root,
    // not primaryWorkspace/backend (doubled path)
    const result = resolveMultiRootPath('backend', primary, allFolders);
    assert.strictEqual(result, secondaryDir);
  });

  test('resolves bare folder name for non-primary folder', () => {
    const result = resolveMultiRootPath('shared', primary, allFolders);
    assert.strictEqual(result, tertiaryDir);
  });

  test('resolves bare primary folder name to primary root', () => {
    const result = resolveMultiRootPath('frontend', primary, allFolders);
    assert.strictEqual(result, primaryDir);
  });

  test('bare name that does not match any folder falls back to primary', () => {
    const result = resolveMultiRootPath('nonexistent', primary, allFolders);
    assert.strictEqual(result, path.join(primaryDir, 'nonexistent'));
  });

  // ─── Fallback for new files ─────────────────────────────────────

  test('non-existent file falls back to primary workspace (write-safe)', () => {
    const result = resolveMultiRootPath('new-dir/new-file.ts', primary, allFolders);
    assert.strictEqual(result, path.join(primaryDir, 'new-dir/new-file.ts'));
  });

  test('deeply nested non-existent path falls back to primary', () => {
    const result = resolveMultiRootPath('a/b/c/d/e.ts', primary, allFolders);
    assert.strictEqual(result, path.join(primaryDir, 'a/b/c/d/e.ts'));
  });

  // ─── Edge cases ─────────────────────────────────────────────────

  test('empty relative path joins to primary root', () => {
    const result = resolveMultiRootPath('', primary, allFolders);
    assert.strictEqual(result, primaryDir);
  });

  test('handles paths with trailing separator', () => {
    const result = resolveMultiRootPath('src/', primary, allFolders);
    // Should find the src/ dir in primary
    assert.strictEqual(result, path.join(primaryDir, 'src/'));
  });

  test('handles dot-relative paths', () => {
    const result = resolveMultiRootPath('./src/app.ts', primary, allFolders);
    assert.strictEqual(result, path.join(primaryDir, './src/app.ts'));
  });
});
