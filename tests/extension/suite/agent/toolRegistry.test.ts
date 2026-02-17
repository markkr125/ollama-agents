import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolContext, ToolRegistry } from '../../../../src/agent/toolRegistry';

suite('toolRegistry', () => {
  let toolRegistry: ToolRegistry;
  let testWorkspaceFolder: vscode.WorkspaceFolder;
  let testDir: string;
  let outputChannel: vscode.OutputChannel;
  let context: ToolContext;

  suiteSetup(async () => {
    // Create a temporary directory for testing
    testDir = path.join(os.tmpdir(), `ollama-copilot-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    
    // Create a test file
    fs.writeFileSync(path.join(testDir, 'test.txt'), 'Hello World');
    fs.writeFileSync(path.join(testDir, 'package.json'), '{"name": "test-project"}');

    testWorkspaceFolder = {
      uri: vscode.Uri.file(testDir),
      name: 'test-workspace',
      index: 0
    };

    outputChannel = vscode.window.createOutputChannel('Test');
    
    context = {
      workspace: testWorkspaceFolder,
      token: new vscode.CancellationTokenSource().token,
      outputChannel
    };

    toolRegistry = new ToolRegistry();
    toolRegistry.registerBuiltInTools();
  });

  suiteTeardown(() => {
    // Cleanup
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    outputChannel.dispose();
  });

  suite('read_file tool', () => {
    test('accepts "path" argument', async () => {
      const result = await toolRegistry.execute('read_file', { path: 'test.txt' }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.output, 'Hello World');
    });

    test('accepts "file" argument', async () => {
      const result = await toolRegistry.execute('read_file', { file: 'test.txt' }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.output, 'Hello World');
    });

    test('accepts "filePath" argument', async () => {
      const result = await toolRegistry.execute('read_file', { filePath: 'test.txt' }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.output, 'Hello World');
    });

    test('returns error for missing path argument', async () => {
      const result = await toolRegistry.execute('read_file', {}, context);
      
      assert.ok(result.error);
      assert.ok(result.error.includes('Missing required argument'));
    });

    test('returns error for non-existent file', async () => {
      const result = await toolRegistry.execute('read_file', { path: 'nonexistent.txt' }, context);
      
      assert.ok(result.error);
    });
  });

  suite('write_file tool', () => {
    test('accepts "path" argument', async () => {
      const result = await toolRegistry.execute('write_file', { 
        path: 'output1.txt', 
        content: 'test content 1' 
      }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('Successfully wrote'));
      
      // Verify file was written
      const content = fs.readFileSync(path.join(testDir, 'output1.txt'), 'utf8');
      assert.strictEqual(content, 'test content 1');
    });

    test('accepts "file" argument', async () => {
      const result = await toolRegistry.execute('write_file', { 
        file: 'output2.txt', 
        content: 'test content 2' 
      }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      
      const content = fs.readFileSync(path.join(testDir, 'output2.txt'), 'utf8');
      assert.strictEqual(content, 'test content 2');
    });

    test('accepts "filePath" argument', async () => {
      const result = await toolRegistry.execute('write_file', { 
        filePath: 'output3.txt', 
        content: 'test content 3' 
      }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      
      const content = fs.readFileSync(path.join(testDir, 'output3.txt'), 'utf8');
      assert.strictEqual(content, 'test content 3');
    });

    test('writes JSON content correctly', async () => {
      const jsonContent = '{"name": "demo project 1", "version": "1.0.0"}';
      const result = await toolRegistry.execute('write_file', { 
        path: 'package-new.json', 
        content: jsonContent 
      }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      
      const content = fs.readFileSync(path.join(testDir, 'package-new.json'), 'utf8');
      assert.strictEqual(content, jsonContent);
    });

    test('writes content with special characters', async () => {
      const specialContent = 'Line 1\nLine 2\n"quoted"\ttabbed';
      const result = await toolRegistry.execute('write_file', { 
        path: 'special.txt', 
        content: specialContent 
      }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      
      const content = fs.readFileSync(path.join(testDir, 'special.txt'), 'utf8');
      assert.strictEqual(content, specialContent);
    });

    test('returns error for missing path argument', async () => {
      const result = await toolRegistry.execute('write_file', { content: 'test' }, context);
      
      assert.ok(result.error);
      assert.ok(result.error.includes('Missing required argument'));
    });
  });

  suite('list_files tool', () => {
    test('lists files in workspace root', async () => {
      const result = await toolRegistry.execute('list_files', {}, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('test.txt'));
      assert.ok(result.output?.includes('package.json'));
    });

    test('accepts empty path for root', async () => {
      const result = await toolRegistry.execute('list_files', { path: '' }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('test.txt'));
    });
  });

  suite('get_diagnostics tool', () => {
    test('accepts "path" argument', async () => {
      const result = await toolRegistry.execute('get_diagnostics', { path: 'test.txt' }, context);
      
      // Should not error (may have no diagnostics)
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
    });

    test('accepts "file" argument', async () => {
      const result = await toolRegistry.execute('get_diagnostics', { file: 'test.txt' }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
    });

    test('accepts "filePath" argument', async () => {
      const result = await toolRegistry.execute('get_diagnostics', { filePath: 'test.txt' }, context);
      
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
    });
  });

  suite('Tool registration', () => {
    test('all expected tools are registered', () => {
      const tools = toolRegistry.getAll();
      const toolNames = tools.map(t => t.name);
      
      assert.ok(toolNames.includes('read_file'));
      assert.ok(toolNames.includes('write_file'));
      assert.ok(toolNames.includes('list_files'));
      assert.ok(toolNames.includes('search_workspace'));
      assert.ok(toolNames.includes('run_terminal_command'));
      assert.ok(toolNames.includes('get_diagnostics'));
      assert.ok(toolNames.includes('get_document_symbols'));
      assert.ok(toolNames.includes('find_definition'));
      assert.ok(toolNames.includes('find_references'));
      assert.ok(toolNames.includes('find_symbol'));
      assert.ok(toolNames.includes('get_hover_info'));
      assert.ok(toolNames.includes('get_call_hierarchy'));
      assert.ok(toolNames.includes('find_implementations'));
      assert.ok(toolNames.includes('get_type_hierarchy'));
      assert.ok(toolNames.includes('run_subagent'));
    });

    test('returns error for unknown tool', async () => {
      const result = await toolRegistry.execute('nonexistent_tool', {}, context);
      
      assert.ok(result.error);
      assert.ok(result.error.includes('Unknown tool'));
      assert.ok(result.error.includes('You can ONLY use these tools'), 'Should list available tools');
      assert.ok(result.error.includes('read_file'), 'Should mention read_file as available');
    });
  });

  suite('run_subagent tool', () => {
    test('returns error message when runSubagent callback is not set', async () => {
      const result = await toolRegistry.execute('run_subagent', {
        task: 'Find all TODO comments',
        mode: 'explore'
      }, context);

      assert.ok(!result.error, 'Should not throw an error');
      assert.ok(result.output?.includes('not available'), 'Should indicate sub-agent is not available');
    });

    test('calls runSubagent callback and returns result', async () => {
      const subagentContext: ToolContext = {
        ...context,
        runSubagent: async (task: string, mode: 'explore' | 'review' | 'deep-explore') => {
          return `Found 3 TODOs in ${mode} mode: ${task}`;
        }
      };

      const result = await toolRegistry.execute('run_subagent', {
        task: 'Find all TODO comments',
        mode: 'explore'
      }, subagentContext);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.output?.includes('Found 3 TODOs'));
      assert.ok(result.output?.includes('explore mode'));
    });

    test('defaults to explore mode when mode not specified', async () => {
      let capturedMode = '';
      const subagentContext: ToolContext = {
        ...context,
        runSubagent: async (task: string, mode: 'explore' | 'review' | 'deep-explore') => {
          capturedMode = mode;
          return 'done';
        }
      };

      await toolRegistry.execute('run_subagent', {
        task: 'Investigate something'
      }, subagentContext);

      assert.strictEqual(capturedMode, 'explore');
    });

    test('returns error message when task is missing', async () => {
      const subagentContext: ToolContext = {
        ...context,
        runSubagent: async () => 'done'
      };

      const result = await toolRegistry.execute('run_subagent', {}, subagentContext);

      assert.ok(!result.error, 'Should not throw');
      assert.ok(result.output?.includes('required'), 'Should indicate task is required');
    });
  });
});
