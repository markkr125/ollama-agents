import * as assert from 'assert';

/**
 * Tests for duplicate tool call detection logic.
 *
 * The agent executor uses three mechanisms to prevent tool call spam:
 * 1. Intra-batch dedup — identical tool+args within a single iteration
 * 2. Cross-iteration dedup — same tool+args seen in last 2 iterations
 * 3. Batch size cap — MAX_TOOLS_PER_BATCH (10)
 * 4. All-duplicate warning — injected when all calls are filtered out
 *
 * We replicate the exact dedup logic from agentChatExecutor.ts to test
 * it without needing VS Code, OllamaClient, or database dependencies.
 */

// ── Replicate dedup logic from agentChatExecutor.ts ────────────────

interface ToolCall {
  name: string;
  args: Record<string, any>;
}

const MAX_TOOLS_PER_BATCH = 10;

function buildSignature(tc: ToolCall): string {
  const argsSorted = Object.keys(tc.args || {}).sort()
    .map(k => `${k}=${JSON.stringify(tc.args[k])}`).join('&');
  return `${tc.name}|${argsSorted}`;
}

/**
 * Dedup + cap a batch of tool calls, matching the agent executor logic exactly.
 * Returns { filtered, warnings, allDuplicates }.
 */
function dedup(
  toolCalls: ToolCall[],
  recentToolSignatures: Map<string, number>,
  iteration: number
): {
  filtered: ToolCall[];
  warnings: string[];
  allDuplicates: boolean;
  wasCapped: boolean;
} {
  const seenInBatch = new Set<string>();
  const originalCount = toolCalls.length;
  const warnings: string[] = [];

  let filtered = toolCalls.filter(tc => {
    const sig = buildSignature(tc);

    // Intra-batch duplicate
    if (seenInBatch.has(sig)) {
      warnings.push(`${tc.name} (intra-batch duplicate)`);
      return false;
    }
    seenInBatch.add(sig);

    // Cross-iteration duplicate (seen in last 2 iterations)
    const lastSeen = recentToolSignatures.get(sig);
    if (lastSeen !== undefined && iteration - lastSeen <= 2) {
      warnings.push(`${tc.name} (repeated from iteration ${lastSeen})`);
      return false;
    }

    return true;
  });

  // Register surviving calls
  for (const tc of filtered) {
    recentToolSignatures.set(buildSignature(tc), iteration);
  }

  // Expire old signatures (older than 3 iterations)
  for (const [sig, iter] of recentToolSignatures) {
    if (iteration - iter > 3) recentToolSignatures.delete(sig);
  }

  // Cap batch size
  let wasCapped = false;
  if (filtered.length > MAX_TOOLS_PER_BATCH) {
    filtered = filtered.slice(0, MAX_TOOLS_PER_BATCH);
    wasCapped = true;
  }

  const allDuplicates = filtered.length === 0 && originalCount > 0;

  return { filtered, warnings, allDuplicates, wasCapped };
}

// ── Tests ────────────────────────────────────────────────────────────

suite('Duplicate tool call detection', () => {

  suite('intra-batch dedup', () => {
    test('removes exact duplicate tool+args within same batch', () => {
      const sigs = new Map<string, number>();
      const calls: ToolCall[] = [
        { name: 'read_file', args: { path: 'src/index.ts' } },
        { name: 'read_file', args: { path: 'src/index.ts' } },  // dup
        { name: 'read_file', args: { path: 'src/app.ts' } },    // different args
      ];
      const { filtered, warnings } = dedup(calls, sigs, 1);
      assert.strictEqual(filtered.length, 2, 'Should keep 2 unique calls');
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('intra-batch'));
    });

    test('keeps calls with same name but different args', () => {
      const sigs = new Map<string, number>();
      const calls: ToolCall[] = [
        { name: 'search_workspace', args: { query: 'foo' } },
        { name: 'search_workspace', args: { query: 'bar' } },
      ];
      const { filtered } = dedup(calls, sigs, 1);
      assert.strictEqual(filtered.length, 2, 'Different args should not be deduped');
    });

    test('removes multiple duplicates of same call', () => {
      const sigs = new Map<string, number>();
      const calls: ToolCall[] = [
        { name: 'list_files', args: { path: '.' } },
        { name: 'list_files', args: { path: '.' } },
        { name: 'list_files', args: { path: '.' } },
        { name: 'list_files', args: { path: '.' } },
      ];
      const { filtered, warnings } = dedup(calls, sigs, 1);
      assert.strictEqual(filtered.length, 1, 'Should keep only first instance');
      assert.strictEqual(warnings.length, 3);
    });
  });

  suite('cross-iteration dedup', () => {
    test('removes call repeated from previous iteration', () => {
      const sigs = new Map<string, number>();
      // Iteration 1: read_file
      dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 1);
      // Iteration 2: same call again
      const { filtered, warnings } = dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 2);
      assert.strictEqual(filtered.length, 0, 'Should be deduped as cross-iteration repeat');
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('repeated from iteration 1'));
    });

    test('removes call repeated from 2 iterations ago', () => {
      const sigs = new Map<string, number>();
      dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 1);
      dedup([{ name: 'search_workspace', args: { query: 'hello' } }], sigs, 2);
      // Iteration 3: repeat from iteration 1 (distance = 2, within window)
      const { filtered } = dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 3);
      assert.strictEqual(filtered.length, 0, 'Should be deduped (within 2-iteration window)');
    });

    test('allows call from 3+ iterations ago (outside window)', () => {
      const sigs = new Map<string, number>();
      dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 1);
      dedup([{ name: 'search_workspace', args: { query: 'x' } }], sigs, 2);
      dedup([{ name: 'list_files', args: { path: '.' } }], sigs, 3);
      // Iteration 4: repeat from iteration 1 (distance = 3, outside 2-iteration window)
      const { filtered } = dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 4);
      assert.strictEqual(filtered.length, 1, 'Should be allowed (outside 2-iteration window)');
    });

    test('mixes intra-batch and cross-iteration dedup', () => {
      const sigs = new Map<string, number>();
      dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 1);
      const { filtered, warnings } = dedup([
        { name: 'read_file', args: { path: 'a.ts' } },    // cross-iteration dup
        { name: 'read_file', args: { path: 'b.ts' } },    // unique
        { name: 'read_file', args: { path: 'b.ts' } },    // intra-batch dup
      ], sigs, 2);
      assert.strictEqual(filtered.length, 1, 'Only b.ts should survive');
      assert.strictEqual(warnings.length, 2);
    });
  });

  suite('signature sliding window expiry', () => {
    test('expires signatures older than 3 iterations', () => {
      const sigs = new Map<string, number>();
      dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 1);
      assert.ok(sigs.has('read_file|path="a.ts"'), 'Signature should be stored');

      // Run iterations 2-5 without that call
      dedup([{ name: 'list_files', args: { path: '.' } }], sigs, 2);
      dedup([{ name: 'list_files', args: { path: 'src' } }], sigs, 3);
      dedup([{ name: 'list_files', args: { path: 'lib' } }], sigs, 4);
      // At iteration 4, sig from iteration 1 is 3 iterations old → should expire
      dedup([{ name: 'list_files', args: { path: 'test' } }], sigs, 5);
      // At iteration 5, sig from iteration 1 is 4 iterations old → definitely expired
      assert.ok(!sigs.has('read_file|path="a.ts"'), 'Stale signature should be expired');
    });
  });

  suite('batch size cap', () => {
    test('caps batch at MAX_TOOLS_PER_BATCH (10)', () => {
      const sigs = new Map<string, number>();
      const calls: ToolCall[] = Array.from({ length: 15 }, (_, i) => ({
        name: 'read_file',
        args: { path: `file${i}.ts` },
      }));
      const { filtered, wasCapped } = dedup(calls, sigs, 1);
      assert.strictEqual(filtered.length, MAX_TOOLS_PER_BATCH, `Should cap at ${MAX_TOOLS_PER_BATCH}`);
      assert.ok(wasCapped, 'wasCapped should be true');
    });

    test('does not cap batch at or below limit', () => {
      const sigs = new Map<string, number>();
      const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
        name: 'read_file',
        args: { path: `file${i}.ts` },
      }));
      const { filtered, wasCapped } = dedup(calls, sigs, 1);
      assert.strictEqual(filtered.length, 10, 'All 10 should pass');
      assert.ok(!wasCapped, 'wasCapped should be false');
    });
  });

  suite('all-duplicate warning', () => {
    test('detects when all calls are duplicates', () => {
      const sigs = new Map<string, number>();
      dedup([
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'search_workspace', args: { query: 'test' } },
      ], sigs, 1);

      // Iteration 2: same exact calls
      const { filtered, allDuplicates, warnings } = dedup([
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'search_workspace', args: { query: 'test' } },
      ], sigs, 2);

      assert.strictEqual(filtered.length, 0);
      assert.ok(allDuplicates, 'allDuplicates should be true');
      assert.strictEqual(warnings.length, 2);
    });

    test('allDuplicates is false when some calls survive', () => {
      const sigs = new Map<string, number>();
      dedup([{ name: 'read_file', args: { path: 'a.ts' } }], sigs, 1);

      const { allDuplicates } = dedup([
        { name: 'read_file', args: { path: 'a.ts' } },  // dup
        { name: 'read_file', args: { path: 'b.ts' } },  // new
      ], sigs, 2);

      assert.ok(!allDuplicates, 'allDuplicates should be false when some survive');
    });

    test('allDuplicates is false when batch is empty to begin with', () => {
      const sigs = new Map<string, number>();
      const { allDuplicates } = dedup([], sigs, 1);
      assert.ok(!allDuplicates, 'allDuplicates should be false for empty batch');
    });
  });

  suite('signature construction', () => {
    test('args keys are sorted for consistent signatures', () => {
      const sigs = new Map<string, number>();
      // Call 1: keys in order a, b
      dedup([{ name: 'write_file', args: { path: 'x.ts', content: 'hello' } }], sigs, 1);
      // Call 2: same keys in reverse order → should produce same signature
      const { filtered } = dedup([{ name: 'write_file', args: { content: 'hello', path: 'x.ts' } }], sigs, 2);
      assert.strictEqual(filtered.length, 0, 'Reversed arg order should produce same signature');
    });

    test('empty args produce consistent signature', () => {
      const sig1 = buildSignature({ name: 'list_files', args: {} });
      const sig2 = buildSignature({ name: 'list_files', args: {} });
      assert.strictEqual(sig1, sig2);
      assert.strictEqual(sig1, 'list_files|');
    });

    test('nested object args are properly stringified', () => {
      const sig = buildSignature({ name: 'test', args: { data: { nested: true } } });
      assert.ok(sig.includes('data={"nested":true}'), `Signature should contain JSON: ${sig}`);
    });
  });
});
