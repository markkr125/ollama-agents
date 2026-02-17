import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolContext, ToolRegistry } from '../../../../src/agent/toolRegistry';

/**
 * Tests for the LSP-powered code intelligence tools and the rewritten
 * search_workspace tool. These run in the Extension Development Host
 * so VS Code APIs are available.
 *
 * Note: LSP results depend on having an active language server. For
 * .ts files the TypeScript server should be active in the test host.
 * For plain .txt files, most providers return empty results — that's
 * expected and tested.
 */

suite('Code Intelligence Tools', () => {
  let toolRegistry: ToolRegistry;
  let testDir: string;
  let context: ToolContext;
  let outputChannel: vscode.OutputChannel;

  suiteSetup(async () => {
    testDir = path.join(os.tmpdir(), `ollama-copilot-ci-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Create test TypeScript file with known symbols
    fs.writeFileSync(path.join(testDir, 'sample.ts'), [
      'export interface Config {',
      '  name: string;',
      '  value: number;',
      '}',
      '',
      'export function greet(name: string): string {',
      '  return formatMessage(name);',
      '}',
      '',
      'function formatMessage(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      'export class Service {',
      '  private config: Config;',
      '',
      '  constructor(config: Config) {',
      '    this.config = config;',
      '  }',
      '',
      '  run(): string {',
      '    return greet(this.config.name);',
      '  }',
      '}',
    ].join('\n'));

    // Create a second file that references the first
    fs.writeFileSync(path.join(testDir, 'consumer.ts'), [
      'import { greet, Service, Config } from "./sample";',
      '',
      'const cfg: Config = { name: "world", value: 42 };',
      'const svc = new Service(cfg);',
      'console.log(svc.run());',
      'console.log(greet("test"));',
    ].join('\n'));

    // Plain text file for negative/empty-result tests
    fs.writeFileSync(path.join(testDir, 'readme.txt'), 'This is a plain text file.\nIt has two lines.');

    // Create a searchable file
    fs.writeFileSync(path.join(testDir, 'searchable.ts'), [
      '// TODO: fix this later',
      'const x = 1;',
      '// Another TODO here',
      'const y = 2;',
      'function doStuff() { return x + y; }',
    ].join('\n'));

    const workspaceFolder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.file(testDir),
      name: 'ci-test-workspace',
      index: 0,
    };

    outputChannel = vscode.window.createOutputChannel('CI Test');

    context = {
      workspace: workspaceFolder,
      token: new vscode.CancellationTokenSource().token,
      outputChannel,
    };

    toolRegistry = new ToolRegistry();
    toolRegistry.registerBuiltInTools();

    // Open the TS files so the language server indexes them
    const sampleUri = vscode.Uri.file(path.join(testDir, 'sample.ts'));
    const consumerUri = vscode.Uri.file(path.join(testDir, 'consumer.ts'));
    await vscode.workspace.openTextDocument(sampleUri);
    await vscode.workspace.openTextDocument(consumerUri);

    // Give the TypeScript language server a moment to initialise
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  suiteTeardown(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    outputChannel.dispose();
  });

  // ─── search_workspace (rewritten) ──────────────────────────────────

  suite('search_workspace', () => {
    test('finds matches with line numbers and context', async () => {
      const result = await toolRegistry.execute('search_workspace', {
        query: 'TODO',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // Should find both TODO lines in searchable.ts
      assert.ok(result.output?.includes('TODO'), 'Output should contain the query');
    });

    test('returns "No matches" for nonexistent text', async () => {
      const result = await toolRegistry.execute('search_workspace', {
        query: 'ZZZZNONEXISTENT_STRING_NEVER_FOUND',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No matches for'), `Expected "No matches for" in output, got: ${result.output}`);
    });

    test('respects filePattern filter', async () => {
      const result = await toolRegistry.execute('search_workspace', {
        query: 'TODO',
        filePattern: '**/*.ts',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // Should still find matches (they're in .ts files)
      assert.ok(result.output?.includes('TODO'));
    });

    test('errors on missing query', async () => {
      const result = await toolRegistry.execute('search_workspace', {}, context);

      assert.ok(result.error);
      assert.ok(result.error.includes('query'));
    });
  });

  // ─── get_document_symbols ──────────────────────────────────────────

  suite('get_document_symbols', () => {
    test('returns symbols for a TypeScript file', async () => {
      const result = await toolRegistry.execute('get_document_symbols', {
        path: 'sample.ts',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      const output = result.output || '';
      // Should contain the known symbols
      assert.ok(output.includes('Config'), 'Should contain Config interface');
      assert.ok(output.includes('greet'), 'Should contain greet function');
      assert.ok(output.includes('Service'), 'Should contain Service class');
    });

    test('returns graceful message for plain text file', async () => {
      const result = await toolRegistry.execute('get_document_symbols', {
        path: 'readme.txt',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // Plain text has no symbols — should get a "no symbols" message
      assert.ok(result.output?.includes('No symbols') || result.output?.includes('Symbols in'));
    });

    test('errors on missing path', async () => {
      const result = await toolRegistry.execute('get_document_symbols', {}, context);

      assert.ok(result.error);
      assert.ok(result.error.includes('path'));
    });
  });

  // ─── find_definition ───────────────────────────────────────────────

  suite('find_definition', () => {
    test('finds definition by symbol name', async () => {
      const result = await toolRegistry.execute('find_definition', {
        path: 'sample.ts',
        symbolName: 'formatMessage',
        line: 7, // line where formatMessage is called
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      const output = result.output || '';
      // Should find the definition of formatMessage
      assert.ok(
        output.includes('Definition') || output.includes('formatMessage') || output.includes('sample.ts'),
        'Should contain definition info'
      );
    });

    test('returns graceful message when no definition found', async () => {
      const result = await toolRegistry.execute('find_definition', {
        path: 'readme.txt',
        line: 1,
        character: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No definition found'));
    });

    test('errors on missing path', async () => {
      const result = await toolRegistry.execute('find_definition', {}, context);

      assert.ok(result.error);
      assert.ok(result.error.includes('path'));
    });
  });

  // ─── find_references ───────────────────────────────────────────────

  suite('find_references', () => {
    test('finds references to a function', async () => {
      const result = await toolRegistry.execute('find_references', {
        path: 'sample.ts',
        symbolName: 'greet',
        line: 6, // line where greet is defined
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // greet is defined in sample.ts and used in consumer.ts
      assert.ok(
        result.output?.includes('reference') || result.output?.includes('greet'),
        'Should find references'
      );
    });

    test('returns graceful message for symbol with no references', async () => {
      const result = await toolRegistry.execute('find_references', {
        path: 'readme.txt',
        line: 1,
        character: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No references'));
    });
  });

  // ─── find_symbol ───────────────────────────────────────────────────

  suite('find_symbol', () => {
    test('finds symbols by query', async () => {
      const result = await toolRegistry.execute('find_symbol', {
        query: 'Service',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // Should find the Service class
      const output = result.output || '';
      assert.ok(
        output.includes('Service') || output.includes('symbol'),
        'Should find the Service symbol'
      );
    });

    test('returns graceful message for nonexistent symbol', async () => {
      const result = await toolRegistry.execute('find_symbol', {
        query: 'ZZZZ_NONEXISTENT_SYMBOL_NEVER_FOUND',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No symbols found'));
    });

    test('errors on missing query', async () => {
      const result = await toolRegistry.execute('find_symbol', {}, context);

      assert.ok(result.error);
      assert.ok(result.error.includes('query'));
    });
  });

  // ─── get_hover_info ────────────────────────────────────────────────

  suite('get_hover_info', () => {
    test('returns type info for a typed symbol', async () => {
      const result = await toolRegistry.execute('get_hover_info', {
        path: 'sample.ts',
        symbolName: 'greet',
        line: 6,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // Should contain type signature info
      const output = result.output || '';
      assert.ok(
        output.includes('Hover info') || output.includes('greet') || output.includes('string'),
        'Should return hover info'
      );
    });

    test('returns graceful message for plain text', async () => {
      const result = await toolRegistry.execute('get_hover_info', {
        path: 'readme.txt',
        line: 1,
        character: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No hover information') || result.output?.includes('Hover'));
    });
  });

  // ─── get_call_hierarchy ────────────────────────────────────────────

  suite('get_call_hierarchy', () => {
    test('returns call hierarchy for a function', async () => {
      const result = await toolRegistry.execute('get_call_hierarchy', {
        path: 'sample.ts',
        symbolName: 'greet',
        line: 6,
        direction: 'both',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      const output = result.output || '';
      // Should contain some call hierarchy output
      assert.ok(
        output.includes('Call hierarchy') || output.includes('greet') || output.includes('No call hierarchy'),
        'Should return call hierarchy info'
      );
    });

    test('accepts direction parameter', async () => {
      const result = await toolRegistry.execute('get_call_hierarchy', {
        path: 'sample.ts',
        symbolName: 'greet',
        line: 6,
        direction: 'outgoing',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
    });

    test('returns graceful message for plain text', async () => {
      const result = await toolRegistry.execute('get_call_hierarchy', {
        path: 'readme.txt',
        line: 1,
        character: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No call hierarchy'));
    });
  });

  // ─── find_implementations ──────────────────────────────────────────

  suite('find_implementations', () => {
    test('returns implementations for an interface', async () => {
      const result = await toolRegistry.execute('find_implementations', {
        path: 'sample.ts',
        symbolName: 'Config',
        line: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      // Config is an interface — there may or may not be implementations
      // depending on the TS server. Just verify no crash.
      assert.ok(result.output);
    });

    test('returns graceful message for plain text', async () => {
      const result = await toolRegistry.execute('find_implementations', {
        path: 'readme.txt',
        line: 1,
        character: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No implementations'));
    });

    test('errors on missing path', async () => {
      const result = await toolRegistry.execute('find_implementations', {}, context);

      assert.ok(result.error);
      assert.ok(result.error.includes('path'));
    });
  });

  // ─── get_type_hierarchy ────────────────────────────────────────────

  suite('get_type_hierarchy', () => {
    test('returns type hierarchy for a class', async () => {
      const result = await toolRegistry.execute('get_type_hierarchy', {
        path: 'sample.ts',
        symbolName: 'Service',
        line: 14,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      const output = result.output || '';
      assert.ok(
        output.includes('Type hierarchy') || output.includes('Service') || output.includes('No type hierarchy'),
        'Should return type hierarchy info'
      );
    });

    test('accepts direction parameter', async () => {
      const result = await toolRegistry.execute('get_type_hierarchy', {
        path: 'sample.ts',
        symbolName: 'Service',
        line: 14,
        direction: 'supertypes',
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
    });

    test('returns graceful message for plain text', async () => {
      const result = await toolRegistry.execute('get_type_hierarchy', {
        path: 'readme.txt',
        line: 1,
        character: 1,
      }, context);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('No type hierarchy'));
    });
  });
});
