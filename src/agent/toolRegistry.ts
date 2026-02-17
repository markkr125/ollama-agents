import type { Tool, ToolContext } from '../types/agent';
import type { ToolDefinition } from '../types/ollama';
import { ToolExecution } from '../types/session';
import { builtInTools } from './tools';

// Re-export types from the shared location for backward compatibility
export type { Tool, ToolContext } from '../types/agent';

// ---------------------------------------------------------------------------
// ToolRegistry — manages tool registration, lookup, and execution.
// Individual tool implementations live in src/agent/tools/.
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register all built-in tools from src/agent/tools/.
   */
  registerBuiltInTools(): void {
    for (const tool of builtInTools) {
      this.register(tool);
    }
  }

  /** Register a tool. */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Get tool by name. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools. */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Get tool descriptions for LLM prompt text. */
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

  /** Execute a tool by name. */
  async execute(
    name: string,
    params: any,
    context: ToolContext
  ): Promise<ToolExecution> {
    const tool = this.tools.get(name);

    if (!tool) {
      const available = Array.from(this.tools.keys()).join(', ');
      return {
        tool: name,
        input: params,
        output: '',
        error: `Unknown tool: ${name}. You can ONLY use these tools: ${available}`,
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
}
