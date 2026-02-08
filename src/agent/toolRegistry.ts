import * as vscode from 'vscode';
import type { TerminalManager } from '../services/terminalManager';
import type { ToolDefinition } from '../types/ollama';
import { ToolExecution } from '../types/session';

export interface Tool {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  execute: (params: any, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
  workspace: vscode.WorkspaceFolder;
  token: vscode.CancellationToken;
  outputChannel: vscode.OutputChannel;
  sessionId?: string;
  terminalManager?: TerminalManager;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register all built-in tools
   */
  registerBuiltInTools(): void {
    this.register({
      name: 'read_file',
      description: 'Read the contents of a file',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          file: { type: 'string', description: 'Alternative: file path relative to workspace' }
        },
        required: []
      },
      execute: async (params, context) => {
        // Accept both 'path' and 'file' as argument names
        const relativePath = params.path || params.file || params.filePath;
        if (!relativePath || typeof relativePath !== 'string') {
          throw new Error('Missing required argument: path (file path relative to workspace)');
        }
        const filePath = this.resolveWorkspacePath(relativePath, context.workspace);
        const uri = vscode.Uri.file(filePath);
        
        try {
          const content = await vscode.workspace.fs.readFile(uri);
          return new TextDecoder().decode(content);
        } catch (error: any) {
          throw new Error(`Failed to read file: ${error.message}`);
        }
      }
    });

    this.register({
      name: 'write_file',
      description: 'Write content to a file',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          file: { type: 'string', description: 'Alternative: file path relative to workspace' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['content']
      },
      execute: async (params, context) => {
        // Accept both 'path' and 'file' as argument names
        const relativePath = params.path || params.file || params.filePath;
        if (!relativePath || typeof relativePath !== 'string') {
          throw new Error('Missing required argument: path (file path relative to workspace)');
        }
        const filePath = this.resolveWorkspacePath(relativePath, context.workspace);
        const uri = vscode.Uri.file(filePath);
        
        try {
          const content = new TextEncoder().encode(params.content);
          await vscode.workspace.fs.writeFile(uri, content);
          return `Successfully wrote to ${relativePath}`;
        } catch (error: any) {
          throw new Error(`Failed to write file: ${error.message}`);
        }
      }
    });

    this.register({
      name: 'search_workspace',
      description: 'Search for text across workspace files',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Maximum results', default: 20 }
        },
        required: ['query']
      },
      execute: async (params, _context) => {
        const maxResults = params.maxResults || 20;
        const results = await vscode.workspace.findFiles('**/*', '**/node_modules/**', maxResults);
        
        const matches: string[] = [];
        
        for (const uri of results) {
          if (matches.length >= maxResults) {break;}
          
          try {
            const content = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(content);
            
            if (text.toLowerCase().includes(params.query.toLowerCase())) {
              const relativePath = vscode.workspace.asRelativePath(uri);
              matches.push(relativePath);
            }
          } catch {
            // Skip files that can't be read
          }
        }
        
        return matches.length > 0 ? matches.join('\n') : 'No matches found';
      }
    });

    this.register({
      name: 'list_files',
      description: 'List files in a directory',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace (empty for root)' }
        },
        required: []
      },
      execute: async (params, context) => {
        const dirPath = params.path
          ? this.resolveWorkspacePath(params.path, context.workspace)
          : context.workspace.uri.fsPath;
        
        const uri = vscode.Uri.file(dirPath);
        
        try {
          const entries = await vscode.workspace.fs.readDirectory(uri);
          return entries
            .map(([name, type]) => `${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`)
            .join('\n');
        } catch (error: any) {
          throw new Error(`Failed to list directory: ${error.message}`);
        }
      }
    });

    this.register({
      name: 'run_terminal_command',
      description: 'Execute a shell command',
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd: { type: 'string', description: 'Working directory relative to workspace root (leave empty for workspace root)' }
        },
        required: ['command']
      },
      execute: async (params, context) => {
        if (!context.terminalManager || !context.sessionId) {
          throw new Error('Terminal manager not available for this session.');
        }

        const cwd = params.cwd || context.workspace.uri.fsPath;
        const result = await context.terminalManager.executeCommand(
          context.sessionId,
          params.command,
          cwd
        );

        return result.output;
      }
    });

    this.register({
      name: 'get_diagnostics',
      description: 'Get errors and warnings for a file',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          file: { type: 'string', description: 'Alternative: file path relative to workspace' }
        },
        required: []
      },
      execute: async (params, context) => {
        // Accept both 'path' and 'file' as argument names
        const relativePath = params.path || params.file || params.filePath;
        if (!relativePath || typeof relativePath !== 'string') {
          throw new Error('Missing required argument: path (file path relative to workspace)');
        }
        const filePath = this.resolveWorkspacePath(relativePath, context.workspace);
        const uri = vscode.Uri.file(filePath);
        
        const diagnostics = vscode.languages.getDiagnostics(uri);
        
        if (diagnostics.length === 0) {
          return 'No issues found';
        }
        
        return diagnostics
          .map(d => `Line ${d.range.start.line + 1}: [${d.severity}] ${d.message}`)
          .join('\n');
      }
    });
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool descriptions for LLM
   */
  getToolDescriptions(): string {
    return this.getAll()
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n');
  }

  /**
   * Get tool definitions in Ollama native format for the `tools` API parameter.
   * Reshapes existing per-tool JSON schemas into ToolDefinition[].
   */
  getOllamaToolDefinitions(): ToolDefinition[] {
    return this.getAll().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties: tool.schema.properties,
          required: tool.schema.required
        }
      }
    }));
  }

  /**
   * Execute a tool
   */
  async execute(
    name: string,
    params: any,
    context: ToolContext
  ): Promise<ToolExecution> {
    const tool = this.tools.get(name);
    
    if (!tool) {
      return {
        tool: name,
        input: params,
        output: '',
        error: `Unknown tool: ${name}`,
        timestamp: Date.now()
      };
    }

    const startTime = Date.now();
    
    try {
      context.outputChannel.appendLine(`[Tool] Executing ${name}`);
      context.outputChannel.appendLine(`[Input] ${JSON.stringify(params)}`);
      
      const output = await tool.execute(params, context);
      
      context.outputChannel.appendLine(`[Output] ${output}`);
      context.outputChannel.appendLine('---');
      
      return {
        tool: name,
        input: params,
        output,
        timestamp: startTime
      };
      
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      
      context.outputChannel.appendLine(`[Error] ${errorMsg}`);
      context.outputChannel.appendLine('---');
      
      return {
        tool: name,
        input: params,
        output: '',
        error: errorMsg,
        timestamp: startTime
      };
    }
  }

  /**
   * Resolve workspace-relative path
   */
  private resolveWorkspacePath(relativePath: string, workspace: vscode.WorkspaceFolder): string {
    const path = require('path');
    return path.join(workspace.uri.fsPath, relativePath);
  }
}
