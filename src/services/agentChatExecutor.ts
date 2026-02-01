import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { DatabaseService } from '../services/databaseService';
import { OllamaClient } from '../services/ollamaClient';
import { MessageRecord } from '../types/session';
import { WebviewMessageEmitter } from '../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../views/toolUIFormatter';

export class AgentChatExecutor {
  constructor(
    private readonly client: OllamaClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly sessionManager: SessionManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly emitter: WebviewMessageEmitter,
    private readonly refreshExplorer: () => void
  ) {}

  async execute(
    agentSession: any,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    sessionId: string,
    model: string
  ): Promise<{ summary: string; assistantMessage: MessageRecord }> {
    const context = { workspace: agentSession.workspace, token, outputChannel: this.outputChannel };

    const messages: any[] = [
      { role: 'system', content: this.buildAgentSystemPrompt() },
      { role: 'user', content: agentSession.task }
    ];

    let iteration = 0;
    let accumulatedExplanation = '';

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      try {
        let response = '';
        const stream = this.client.chat({ model, messages });

        this.emitter.postMessage({
          type: 'showThinking',
          message: iteration === 1 ? 'Thinking...' : 'Working...',
          sessionId
        });

        for await (const chunk of stream) {
          if (token.isCancellationRequested) break;
          if (chunk.message?.content) {
            response += chunk.message.content;

            const partialTool = this.detectPartialToolCall(response);
            if (partialTool) {
              this.emitter.postMessage({
                type: 'showThinking',
                message: `Preparing to use ${partialTool}...`,
                sessionId
              });
            }
          }
        }

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          break;
        }

        const cleanedText = this.removeToolCalls(response);

        if (cleanedText.trim() && !cleanedText.includes('[TASK_COMPLETE]')) {
          if (accumulatedExplanation) {
            accumulatedExplanation += '\n\n';
          }
          accumulatedExplanation += cleanedText.trim();

          this.emitter.postMessage({
            type: 'streamChunk',
            content: accumulatedExplanation,
            model,
            sessionId
          });
        }

        if (response.includes('[TASK_COMPLETE]') || response.toLowerCase().includes('task is complete')) {
          accumulatedExplanation = cleanedText.replace('[TASK_COMPLETE]', '').trim() || accumulatedExplanation;
          break;
        }

        const toolCalls = this.extractToolCalls(response);

        if (toolCalls.length === 0) {
          messages.push({ role: 'assistant', content: response });
          if (iteration < config.maxIterations - 1) {
            messages.push({
              role: 'user',
              content: 'Continue with the task. Use tools or respond with [TASK_COMPLETE] if finished.'
            });
          }
          continue;
        }

        const groupTitle = getProgressGroupTitle(toolCalls);
        this.emitter.postMessage({
          type: 'startProgressGroup',
          title: groupTitle,
          sessionId
        });

        for (const toolCall of toolCalls) {
          if (token.isCancellationRequested) break;

          const { actionText, actionDetail, actionIcon } = getToolActionInfo(toolCall.name, toolCall.args);

          this.emitter.postMessage({
            type: 'showToolAction',
            status: 'running',
            icon: actionIcon,
            text: actionText,
            detail: actionDetail,
            sessionId
          });

          try {
            const result = await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            agentSession.toolCalls.push(result);

            if (['write_file', 'create_file', 'delete_file'].includes(toolCall.name)) {
              agentSession.filesChanged.push(toolCall.args?.path || toolCall.args?.file);
              this.refreshExplorer();
            }

            if (sessionId) {
              await this.databaseService.addMessage(
                sessionId,
                'tool',
                result.output || '',
                {
                  model,
                  toolName: toolCall.name,
                  toolInput: JSON.stringify(toolCall.args),
                  toolOutput: result.output,
                  progressTitle: groupTitle
                }
              );
            }

            const { actionText: successText, actionDetail: successDetail } =
              getToolSuccessInfo(toolCall.name, toolCall.args, result.output);
            this.emitter.postMessage({
              type: 'showToolAction',
              status: 'success',
              icon: actionIcon,
              text: successText,
              detail: successDetail,
              sessionId
            });

            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: `Tool result for ${toolCall.name}:\n${result.output}\n\nContinue with the task.`
            });
          } catch (error: any) {
            this.emitter.postMessage({
              type: 'showToolAction',
              status: 'error',
              icon: actionIcon,
              text: actionText,
              detail: error.message,
              sessionId
            });
            agentSession.errors.push(error.message);

            if (sessionId) {
              await this.databaseService.addMessage(
                sessionId,
                'tool',
                `Error: ${error.message}`,
                {
                  model,
                  toolName: toolCall.name,
                  toolInput: JSON.stringify(toolCall.args),
                  toolOutput: `Error: ${error.message}`,
                  progressTitle: groupTitle
                }
              );
            }

            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: `Tool ${toolCall.name} failed: ${error.message}\n\nTry a different approach.`
            });
          }
        }
      } catch (error: any) {
        this.emitter.postMessage({ type: 'showError', message: error.message, sessionId });
        break;
      }
    }

    this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
    this.sessionManager.updateSession(agentSession.id, { status: 'completed' });

    const filesChanged = agentSession.filesChanged?.length || 0;
    let summary = filesChanged > 0 ? `**${filesChanged} file${filesChanged > 1 ? 's' : ''} modified**\n\n` : '';
    const toolSummaryLines = (agentSession.toolCalls || [])
      .slice(-6)
      .map((tool: any) => {
        const toolName = tool.tool || tool.name || 'tool';
        const outputLine = (tool.output || '').toString().split('\n').filter(Boolean)[0] || '';
        const detail = tool.error ? `Error: ${tool.error}` : outputLine;
        return `- ${toolName}${detail ? `: ${detail}` : ''}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!accumulatedExplanation.trim()) {
      this.emitter.postMessage({ type: 'showThinking', message: 'Working...', sessionId });
      const toolResults = (agentSession.toolCalls || [])
        .slice(-6)
        .map((tool: any) => `Tool: ${tool.tool || tool.name}\nOutput:\n${(tool.output || '').toString().slice(0, 2000)}`)
        .join('\n\n');

      try {
        const finalStream = this.client.chat({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are a helpful coding assistant. Provide a concise final answer to the user based on tool results. Do not call tools.'
            },
            {
              role: 'user',
              content: `User request: ${agentSession.task}\n\nRecent tool results:\n${toolResults}\n\nProvide the final response now.`
            }
          ]
        });

        let finalResponse = '';
        for await (const chunk of finalStream) {
          if (chunk.message?.content) {
            finalResponse += chunk.message.content;
          }
        }

        accumulatedExplanation = finalResponse.trim();
      } catch {
        // fall back to default message if summarization fails
      }
      this.emitter.postMessage({ type: 'hideThinking', sessionId });
    }

    if (!accumulatedExplanation.trim() && toolSummaryLines) {
      accumulatedExplanation = `Summary of actions:\n${toolSummaryLines}`;
    }

    summary += accumulatedExplanation || 'Task completed successfully.';

    const assistantMessage = await this.databaseService.addMessage(
      sessionId,
      'assistant',
      summary,
      { model }
    );

    this.emitter.postMessage({ type: 'finalMessage', content: summary, model, sessionId });
    this.emitter.postMessage({ type: 'hideThinking', sessionId });

    return { summary, assistantMessage };
  }

  private detectPartialToolCall(response: string): string | null {
    const match = response.match(/<tool_call>\s*\{\s*"name"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  }

  private removeToolCalls(response: string): string {
    return response
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<tool_call>[\s\S]*$/g, '')
      .replace(/```json\s*\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?```/g, '')
      .replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
      .replace(/^\[TOOL_CALLS\][\s\S]*?(?:\n|$)/gm, '')
      .replace(/\[TASK_COMPLETE\]/g, '')
      .trim();
  }

  private extractToolCalls(response: string): Array<{ name: string; args: any }> {
    const toolCalls: Array<{ name: string; args: any }> = [];
    const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let match;

    while ((match = toolCallRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name && parsed.arguments) {
          toolCalls.push({ name: parsed.name, args: parsed.arguments });
        }
      } catch {
        // skip
      }
    }

    const bracketToolCallRegex = /\[TOOL_CALLS\]\s*([^\[]+)\[ARGS\]\s*(\{[\s\S]*?\})(?:\n|$)/g;
    while ((match = bracketToolCallRegex.exec(response)) !== null) {
      const name = (match[1] || '').trim();
      const rawArgs = (match[2] || '').trim().replace(/[“”]/g, '"');
      try {
        const args = rawArgs ? JSON.parse(rawArgs) : {};
        if (name) {
          toolCalls.push({ name, args });
        }
      } catch {
        // skip
      }
    }

    return toolCalls;
  }

  private buildAgentSystemPrompt(): string {
    const tools = this.toolRegistry.getAll();
    return `You are an autonomous AI coding agent with tools.

AVAILABLE TOOLS:
${tools.map((t: { name: string; description: string }) => `- ${t.name}: ${t.description}`).join('\n')}

TO USE A TOOL:
<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>

RULES:
1. Read files before modifying
2. Write complete, working code
3. Use [TASK_COMPLETE] when done`;
  }
}
