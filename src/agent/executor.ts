import * as vscode from 'vscode';
import { OllamaClient } from '../services/model/ollamaClient';
import type { ExecutorConfig } from '../types/agent';
import { ChatMessage, ToolCall } from '../types/ollama';
import { Session, ToolExecution } from '../types/session';
import { ToolContext, ToolRegistry } from './toolRegistry';

// Re-export for backward compatibility with agentMode.ts
export type { ExecutorConfig } from '../types/agent';

export class AgentExecutor {
  constructor(
    private client: OllamaClient,
    private toolRegistry: ToolRegistry,
    private outputChannel: vscode.OutputChannel
  ) {}

  /**
   * Execute agent task
   */
  async execute(
    session: Session,
    config: ExecutorConfig,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!session.workspace) {
      throw new Error('No workspace available');
    }

    const context: ToolContext = {
      workspace: session.workspace,
      token,
      outputChannel: this.outputChannel
    };

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt()
      },
      {
        role: 'user',
        content: session.task
      }
    ];

    let iteration = 0;

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;
      
      this.outputChannel.appendLine(`\n=== Iteration ${iteration} ===`);

      try {
        const response = await this.generateResponse(messages, session.model, config, token);

        if (!response) {
          break;
        }

        // Check if task is complete
        if (this.isTaskComplete(response)) {
          this.outputChannel.appendLine('[Agent] Task marked as complete');
          break;
        }

        // Extract and execute tool calls
        const toolCalls = this.extractToolCalls(response);

        if (toolCalls.length === 0) {
          // No tool calls, add response to messages and continue
          messages.push({
            role: 'assistant',
            content: response
          });

          // Ask for next action
          messages.push({
            role: 'user',
            content: 'Continue with the next step or tool call.'
          });
          
          continue;
        }

        // Execute tools
        const toolResults: ToolExecution[] = [];

        for (const toolCall of toolCalls) {
          const result = await this.toolRegistry.execute(
            toolCall.function.name,
            toolCall.function.arguments,
            context
          );

          toolResults.push(result);
          session.toolCalls.push(result);

          if (result.error) {
            session.errors.push(`Tool ${result.tool}: ${result.error}`);
          }

          // Track file changes
          if (toolCall.function.name === 'write_file') {
            const filePath = toolCall.function.arguments.path;
            if (!session.filesChanged.includes(filePath)) {
              session.filesChanged.push(filePath);
            }
          }
        }

        // Add tool results to conversation
        messages.push({
          role: 'assistant',
          content: response
        });

        const toolResultsMessage = toolResults
          .map(r => `Tool: ${r.tool}\nResult: ${r.error || r.output}`)
          .join('\n\n');

        messages.push({
          role: 'user',
          content: `Tool results:\n${toolResultsMessage}\n\nContinue with next step.`
        });

      } catch (error: any) {
        session.errors.push(error.message);
        this.outputChannel.appendLine(`[Error] ${error.message}`);
        
        if (iteration >= 3) {
          throw error;
        }
      }
    }

    if (iteration >= config.maxIterations) {
      this.outputChannel.appendLine('[Agent] Max iterations reached');
    }
  }

  /**
   * Generate response from LLM
   */
  private async generateResponse(
    messages: ChatMessage[],
    model: string,
    config: ExecutorConfig,
    token: vscode.CancellationToken
  ): Promise<string | null> {
    let fullResponse = '';

    const stream = this.client.chat({
      model,
      messages,
      options: {
        temperature: config.temperature
      }
    });

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        return null;
      }

      const content = chunk.message?.content || chunk.response || '';
      if (content) {
        fullResponse += content;
      }

      if (chunk.done) {
        break;
      }
    }

    return fullResponse;
  }

  /**
   * Build system prompt with tool descriptions
   */
  private buildSystemPrompt(): string {
    const toolDescriptions = this.toolRegistry.getToolDescriptions();

    return `You are an autonomous coding agent. Your goal is to complete the user's task by using available tools.

Available tools:
${toolDescriptions}

To use a tool, output JSON in this format:
\`\`\`json
{
  "tool": "tool_name",
  "params": {
    "param1": "value1"
  }
}
\`\`\`

Guidelines:
- Break down complex tasks into steps
- Use tools to gather information before making changes
- Read files before modifying them
- Check diagnostics after making changes
- When task is complete, say "TASK_COMPLETE"
- Be systematic and careful`;
  }

  /**
   * Extract tool calls from response
   */
  private extractToolCalls(response: string): ToolCall[] {
    const calls: ToolCall[] = [];
    
    // Match JSON code blocks
    const jsonBlocks = response.matchAll(/```json\s*\n([\s\S]*?)\n```/g);

    for (const match of jsonBlocks) {
      try {
        const parsed = JSON.parse(match[1]);
        
        if (parsed.tool && parsed.params) {
          calls.push({
            id: `call-${Date.now()}-${calls.length}`,
            type: 'function',
            function: {
              name: parsed.tool,
              arguments: parsed.params
            }
          });
        }
      } catch (_error) {
        // Invalid JSON, skip
      }
    }

    return calls;
  }

  /**
   * Check if task is marked as complete
   */
  private isTaskComplete(response: string): boolean {
    return /TASK[_\s]COMPLETE/i.test(response);
  }
}
