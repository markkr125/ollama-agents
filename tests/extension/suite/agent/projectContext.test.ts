import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Tests for projectContext.ts — auto-discovery of project files for context.
 *
 * Creates a temporary directory with mock project files and verifies
 * discoverProjectContext() reads and formats them correctly.
 */

// We need to import the function directly. It uses vscode.WorkspaceFolder.
import { discoverProjectContext } from '../../../../src/agent/execution/prompts/projectContext';

function createMockWorkspaceFolder(fsPath: string): any {
  return {
    name: path.basename(fsPath),
    uri: { fsPath },
    index: 0
  };
}

suite('projectContext', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-copilot-test-'));
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns empty context when no workspace folder', async () => {
    const result = await discoverProjectContext(undefined);
    assert.strictEqual(result.contextBlock, '');
    assert.strictEqual(result.filesRead.length, 0);
    assert.strictEqual(result.projectType, 'unknown');
  });

  test('returns empty context when no recognized files exist', async () => {
    // Create only unrecognized files
    await fs.writeFile(path.join(tmpDir, 'random.xyz'), 'content');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.contextBlock, '');
    assert.strictEqual(result.filesRead.length, 0);
  });

  test('reads package.json and detects TypeScript/Node.js project', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: { typescript: '^5.0.0' }
    }));
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.ok(result.contextBlock.includes('<project_context>'), 'Should have project_context wrapper');
    assert.ok(result.contextBlock.includes('package.json'), 'Should include package.json');
    assert.strictEqual(result.projectType, 'TypeScript/Node.js');
    assert.ok(result.filesRead.includes('package.json'), 'Should list package.json as read');
  });

  test('detects React project from dependencies', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'react-app',
      dependencies: { react: '^18.0.0' }
    }));
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.projectType, 'React');
  });

  test('detects Next.js project from dependencies', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'next-app',
      dependencies: { next: '^14.0.0', react: '^18.0.0' }
    }));
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.projectType, 'Next.js (TypeScript/JavaScript)');
  });

  test('detects VS Code Extension project from dependencies', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'vscode-ext',
      devDependencies: { '@types/vscode': '^1.80.0' }
    }));
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.projectType, 'VS Code Extension (TypeScript)');
  });

  test('detects Python project from pyproject.toml', async () => {
    await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.projectType, 'Python');
    assert.ok(result.filesRead.includes('pyproject.toml'));
  });

  test('detects Rust project from Cargo.toml', async () => {
    await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.projectType, 'Rust');
    assert.ok(result.filesRead.includes('Cargo.toml'));
  });

  test('reads AI instruction files (CLAUDE.md)', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '# Project instructions\nDo the thing.');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.ok(result.filesRead.includes('CLAUDE.md'), 'Should read CLAUDE.md');
    assert.ok(result.contextBlock.includes('Project instructions'), 'Should include content');
  });

  test('truncates large files at MAX_FILE_BYTES (4000 chars)', async () => {
    const largeContent = 'A'.repeat(5000);
    await fs.writeFile(path.join(tmpDir, 'README.md'), largeContent);
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.ok(result.contextBlock.includes('... (truncated)'), 'Should indicate truncation');
    // The truncated content should be 4000 chars
    assert.ok(!result.contextBlock.includes('A'.repeat(5000)), 'Should not include full content');
  });

  test('respects MAX_TOTAL_BYTES (12000) — stops reading after budget', async () => {
    // Total budget is 12000, per-file cap is 4000. 
    // Fill exactly 3 files at ~4000 each to exhaust the 12000 budget.
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), 'X'.repeat(4500));
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', description: 'Y'.repeat(4500) }));
    await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), 'Z'.repeat(4500));
    await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), 'Should not be read — budget exceeded');
    // Budget: CLAUDE.md=4000 + package.json=4000 + pyproject.toml=4000 = 12000 → budget hit

    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));

    // Cargo.toml should not be in filesRead because budget is exhausted
    assert.ok(!result.filesRead.includes('Cargo.toml'), 'Cargo.toml should be skipped (budget exceeded)');
    assert.ok(result.filesRead.length <= 3, 'Should read at most 3 files within budget');
  });

  test('silently skips missing files', async () => {
    // Only create package.json — all other well-known files are missing
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test"}');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.strictEqual(result.filesRead.length, 1, 'Should only read the one existing file');
    assert.ok(result.filesRead.includes('package.json'));
  });

  test('reads .github/copilot-instructions.md when present', async () => {
    await fs.mkdir(path.join(tmpDir, '.github'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), '# Instructions\nBe helpful.');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.ok(result.filesRead.includes('.github/copilot-instructions.md'));
    assert.ok(result.contextBlock.includes('Be helpful'));
  });

  test('priority ordering: AI files before project metadata', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), 'AI instructions');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test"}');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));

    const claudeIndex = result.filesRead.indexOf('CLAUDE.md');
    const pkgIndex = result.filesRead.indexOf('package.json');
    assert.ok(claudeIndex < pkgIndex, 'CLAUDE.md should come before package.json');
  });

  test('contextBlock includes project type label', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test","dependencies":{"typescript":"^5"}}');
    const result = await discoverProjectContext(createMockWorkspaceFolder(tmpDir));
    assert.ok(result.contextBlock.includes('Project type: TypeScript/Node.js'), 'Should label project type');
  });
});
