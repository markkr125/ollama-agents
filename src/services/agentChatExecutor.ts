import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { DatabaseService } from '../services/databaseService';
import { OllamaClient } from '../services/ollamaClient';
import { TerminalManager } from '../services/terminalManager';
import { MessageRecord } from '../types/session';
import { analyzeDangerousCommand } from '../utils/commandSafety';
import { WebviewMessageEmitter } from '../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../views/toolUIFormatter';

export class AgentChatExecutor {
  private pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();

  constructor(
    private readonly client: OllamaClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly sessionManager: SessionManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly emitter: WebviewMessageEmitter,
    private readonly refreshExplorer: () => void,
    private readonly terminalManager: TerminalManager
  ) {}

  handleToolApprovalResponse(approvalId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    pending.resolve(approved);
    this.pendingApprovals.delete(approvalId);
  }

  async execute(
    agentSession: any,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    sessionId: string,
    model: string
  ): Promise<{ summary: string; assistantMessage: MessageRecord }> {
    const context = {
      workspace: agentSession.workspace,
      token,
      outputChannel: this.outputChannel,
      sessionId,
      terminalManager: this.terminalManager
    };

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
          const isTerminalCommand = toolCall.name === 'run_terminal_command' || toolCall.name === 'run_command';

          if (!isTerminalCommand) {
            this.emitter.postMessage({
              type: 'showToolAction',
              status: 'running',
              icon: actionIcon,
              text: actionText,
              detail: actionDetail,
              sessionId
            });
          }

          try {
            const result = isTerminalCommand
              ? await this.executeTerminalCommand(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
              : await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
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

            const isSkipped =
              (toolCall.name === 'run_terminal_command' || toolCall.name === 'run_command') &&
              (result.output || '').toLowerCase().includes('skipped by user');

            if (isSkipped) {
              this.emitter.postMessage({
                type: 'showToolAction',
                status: 'error',
                icon: actionIcon,
                text: 'Command skipped',
                detail: 'Skipped by user',
                sessionId
              });
            } else {
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
            }

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

        // Finish the progress group after processing all tool calls in this iteration
        this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
      } catch (error: any) {
        this.emitter.postMessage({ type: 'showError', message: error.message, sessionId });
        break;
      }
    }

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

  private async executeTerminalCommand(
    toolName: string,
    args: any,
    context: any,
    sessionId: string,
    actionText: string,
    actionIcon: string,
    token: vscode.CancellationToken
  ) {
    const command = String(args?.command || '').trim();
    if (!command) {
      throw new Error('No command provided for terminal execution.');
    }

    const cwd = String(args?.cwd || context.workspace.uri.fsPath);
    const resolvedToolName = toolName === 'run_command' ? 'run_terminal_command' : toolName;
    const analysis = analyzeDangerousCommand(command);
    const sessionRecord = sessionId ? await this.databaseService.getSession(sessionId) : null;
    const autoApproveEnabled = !!sessionRecord?.auto_approve_commands;
    const requiresApproval = analysis.severity === 'critical' || !autoApproveEnabled;

    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const severity = analysis.severity === 'none' ? 'medium' : analysis.severity;
    const reason = analysis.reason || 'Command requires approval';

    if (requiresApproval) {
      this.emitter.postMessage({
        type: 'requestToolApproval',
        sessionId,
        approval: {
          id: approvalId,
          command,
          cwd,
          severity,
          reason,
          status: 'pending',
          timestamp: Date.now()
        }
      });

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'pending',
        icon: actionIcon,
        text: actionText,
        detail: 'Awaiting approval',
        sessionId
      });

      const approved = await this.waitForApproval(approvalId, token);
      if (!approved) {
        const skippedOutput = 'Command skipped by user.';

        this.emitter.postMessage({
          type: 'toolApprovalResult',
          sessionId,
          approvalId,
          status: 'skipped',
          output: skippedOutput
        });

        return {
          tool: toolName,
          input: args,
          output: skippedOutput,
          timestamp: Date.now()
        };
      }

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: command.substring(0, 60),
        sessionId
      });
    } else {
      this.emitter.postMessage({
        type: 'toolApprovalResult',
        sessionId,
        approvalId,
        status: 'approved',
        output: 'Auto-approved for this session.',
        autoApproved: true,
        command,
        cwd,
        severity,
        reason
      });

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: command.substring(0, 60),
        sessionId
      });
    }

    const result = await this.toolRegistry.execute(resolvedToolName, args, context);
    const exitCodeMatch = (result.output || '').match(/Exit code:\s*(\d+)/i);
    const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : null;

    this.emitter.postMessage({
      type: 'toolApprovalResult',
      sessionId,
      approvalId,
      status: 'approved',
      output: result.output,
      exitCode
    });

    return result;
  }

  private waitForApproval(approvalId: string, token: vscode.CancellationToken): Promise<boolean> {
    return new Promise(resolve => {
      const onCancel = token.onCancellationRequested(() => {
        onCancel.dispose();
        this.pendingApprovals.delete(approvalId);
        resolve(false);
      });

      this.pendingApprovals.set(approvalId, {
        resolve: (approved: boolean) => {
          onCancel.dispose();
          resolve(approved);
        }
      });
    });
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
