import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHUNK_SIZE, countFileLines, readFileChunk } from '../../../../src/agent/tools/filesystem/readFile';

suite('readFile streaming helpers', () => {
  let testDir: string;

  suiteSetup(() => {
    testDir = path.join(os.tmpdir(), `ollama-copilot-readfile-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  suiteTeardown(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── CHUNK_SIZE constant ─────────────────────────────────────────────

  test('CHUNK_SIZE is 100', () => {
    assert.strictEqual(CHUNK_SIZE, 100);
  });

  // ─── countFileLines ──────────────────────────────────────────────────

  test('countFileLines counts lines in a small file', async () => {
    const filePath = path.join(testDir, 'small.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\n');
    const count = await countFileLines(filePath);
    assert.strictEqual(count, 3);
  });

  test('countFileLines returns 1 for a single-line file without trailing newline', async () => {
    const filePath = path.join(testDir, 'one-line.txt');
    fs.writeFileSync(filePath, 'only one');
    const count = await countFileLines(filePath);
    assert.strictEqual(count, 1);
  });

  test('countFileLines returns 0 for an empty file', async () => {
    const filePath = path.join(testDir, 'empty.txt');
    fs.writeFileSync(filePath, '');
    const count = await countFileLines(filePath);
    assert.strictEqual(count, 0);
  });

  test('countFileLines handles 200 lines correctly', async () => {
    const filePath = path.join(testDir, 'big.txt');
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));
    const count = await countFileLines(filePath);
    assert.strictEqual(count, 200);
  });

  test('countFileLines rejects for nonexistent file', async () => {
    await assert.rejects(
      () => countFileLines(path.join(testDir, 'no-such-file.txt')),
      { code: 'ENOENT' }
    );
  });

  // ─── readFileChunk ───────────────────────────────────────────────────

  test('readFileChunk reads first chunk of a multi-line file', async () => {
    const filePath = path.join(testDir, 'chunk-test.txt');
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const chunk = await readFileChunk(filePath, 1, 100);
    const chunkLines = chunk.split('\n');
    assert.strictEqual(chunkLines.length, 100);
    assert.strictEqual(chunkLines[0], 'line 1');
    assert.strictEqual(chunkLines[99], 'line 100');
  });

  test('readFileChunk reads second chunk correctly', async () => {
    const filePath = path.join(testDir, 'chunk-test.txt');
    // Re-use file written above (150 lines)
    const chunk = await readFileChunk(filePath, 101, 150);
    const chunkLines = chunk.split('\n');
    assert.strictEqual(chunkLines.length, 50);
    assert.strictEqual(chunkLines[0], 'line 101');
    assert.strictEqual(chunkLines[49], 'line 150');
  });

  test('readFileChunk reads full file when range covers all lines', async () => {
    const filePath = path.join(testDir, 'fullread.txt');
    fs.writeFileSync(filePath, 'a\nb\nc');
    const content = await readFileChunk(filePath, 1, 3);
    assert.strictEqual(content, 'a\nb\nc');
  });

  test('readFileChunk handles single-line range', async () => {
    const filePath = path.join(testDir, 'single-line-range.txt');
    fs.writeFileSync(filePath, 'one\ntwo\nthree');
    const content = await readFileChunk(filePath, 2, 2);
    assert.strictEqual(content, 'two');
  });

  test('readFileChunk stops early and does not read beyond endLine', async () => {
    const filePath = path.join(testDir, 'early-stop.txt');
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const chunk = await readFileChunk(filePath, 1, 10);
    const chunkLines = chunk.split('\n');
    assert.strictEqual(chunkLines.length, 10);
    assert.strictEqual(chunkLines[9], 'line 10');
  });

  test('readFileChunk rejects for nonexistent file', async () => {
    await assert.rejects(
      () => readFileChunk(path.join(testDir, 'nope.txt'), 1, 10),
      { code: 'ENOENT' }
    );
  });

  test('readFileChunk with exactly CHUNK_SIZE lines returns all of them', async () => {
    const filePath = path.join(testDir, 'exact-chunk.txt');
    const lines = Array.from({ length: CHUNK_SIZE }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const chunk = await readFileChunk(filePath, 1, CHUNK_SIZE);
    const chunkLines = chunk.split('\n');
    assert.strictEqual(chunkLines.length, CHUNK_SIZE);
  });

  test('readFileChunk with CHUNK_SIZE + 1 lines — first chunk reads exactly CHUNK_SIZE', async () => {
    const filePath = path.join(testDir, 'one-over.txt');
    const lines = Array.from({ length: CHUNK_SIZE + 1 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const firstChunk = await readFileChunk(filePath, 1, CHUNK_SIZE);
    assert.strictEqual(firstChunk.split('\n').length, CHUNK_SIZE);

    const secondChunk = await readFileChunk(filePath, CHUNK_SIZE + 1, CHUNK_SIZE + 1);
    assert.strictEqual(secondChunk, `line ${CHUNK_SIZE + 1}`);
  });
});
