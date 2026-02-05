import * as path from 'path';
import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { DatabaseService } from '../services/databaseService';
import { OllamaClient } from '../services/ollamaClient';
import { TerminalManager } from '../services/terminalManager';
import { MessageRecord } from '../types/session';
import { analyzeDangerousCommand } from '../utils/commandSafety';
import { renderDiffHtml } from '../utils/diffRenderer';
import { DEFAULT_SENSITIVE_FILE_PATTERNS, evaluateFileSensitivity } from '../utils/fileSensitivity';
import { computeTerminalApprovalDecision } from '../utils/terminalApproval';
import { detectPartialToolCall, extractToolCalls, removeToolCalls } from '../utils/toolCallParser';
import { WebviewMessageEmitter } from '../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../views/toolUIFormatter';
import { EditManager } from './editManager';

export class AgentChatExecutor {
  private pendingApprovals = new Map<string, { resolve: (result: { approved: boolean; command?: string }) => void }>();

  private async persistUiEvent(
    sessionId: string | undefined,
    eventType: string,
    payload: Record<string, any>
  ): Promise<void> {
    if (!sessionId) return;
    try {
      await this.databaseService.addMessage(sessionId, 'tool', '', {
        toolName: '__ui__',
        toolOutput: JSON.stringify({ eventType, payload })
      });
    } catch (error) {
      console.warn('[persistUiEvent] Failed to persist UI event:', error);
    }
  }
  private fileApprovalCache = new Map<string, { filePath: string; displayPath: string; originalContent: string; newContent: string }>();
  private editManager: EditManager;

  constructor(
    private readonly client: OllamaClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly sessionManager: SessionManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly emitter: WebviewMessageEmitter,
    private readonly refreshExplorer: () => void,
    private readonly terminalManager: TerminalManager
  ) {
    this.editManager = new EditManager(this.client);
  }

  handleToolApprovalResponse(approvalId: string, approved: boolean, command?: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    pending.resolve({ approved, command });
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

            const partialTool = detectPartialToolCall(response);
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

        const cleanedText = removeToolCalls(response);

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

        const toolCalls = extractToolCalls(response);

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

        // Save the assistant's explanation BEFORE executing tools
        // This ensures proper message ordering when loading from history
        if (accumulatedExplanation.trim() && sessionId) {
          await this.databaseService.addMessage(
            sessionId,
            'assistant',
            accumulatedExplanation.trim(),
            { model }
          );
          // Don't clear accumulatedExplanation - we'll append to it after tools
          // Don't send finalMessage here - that would split the message in UI
        }

        const groupTitle = getProgressGroupTitle(toolCalls);
        this.emitter.postMessage({
          type: 'startProgressGroup',
          title: groupTitle,
          sessionId
        });
        await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });

        for (const toolCall of toolCalls) {
          if (token.isCancellationRequested) break;

          const { actionText, actionDetail, actionIcon } = getToolActionInfo(toolCall.name, toolCall.args);
          const isTerminalCommand = toolCall.name === 'run_terminal_command' || toolCall.name === 'run_command';
          const isFileEdit = toolCall.name === 'write_file' || toolCall.name === 'create_file';

          if (!isTerminalCommand && !isFileEdit) {
            this.emitter.postMessage({
              type: 'showToolAction',
              status: 'running',
              icon: actionIcon,
              text: actionText,
              detail: actionDetail,
              sessionId
            });
            // Don't persist running state - only final states matter for history
          }

          try {
            const result = isTerminalCommand
              ? await this.executeTerminalCommand(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
              : isFileEdit
                ? await this.executeFileEdit(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
                : await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            agentSession.toolCalls.push(result);

            if (['write_file', 'create_file', 'delete_file'].includes(toolCall.name)) {
              const skippedEdit = (result.output || '').toLowerCase().includes('skipped by user');
              if (!skippedEdit) {
                agentSession.filesChanged.push(toolCall.args?.path || toolCall.args?.file);
                this.refreshExplorer();
              }
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

            const isFileEditSkipped =
              (toolCall.name === 'write_file' || toolCall.name === 'create_file') &&
              (result.output || '').toLowerCase().includes('skipped by user');

            if (isSkipped || isFileEditSkipped) {
              this.emitter.postMessage({
                type: 'showToolAction',
                status: 'error',
                icon: actionIcon,
                text: isFileEditSkipped ? 'Edit skipped' : 'Command skipped',
                detail: 'Skipped by user',
                sessionId
              });
              await this.persistUiEvent(sessionId, 'showToolAction', {
                status: 'error',
                icon: actionIcon,
                text: isFileEditSkipped ? 'Edit skipped' : 'Command skipped',
                detail: 'Skipped by user'
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
              await this.persistUiEvent(sessionId, 'showToolAction', {
                status: 'success',
                icon: actionIcon,
                text: successText,
                detail: successDetail
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
            await this.persistUiEvent(sessionId, 'showToolAction', {
              status: 'error',
              icon: actionIcon,
              text: actionText,
              detail: error.message
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
        await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
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
    const { requiresApproval, severity, reason } = computeTerminalApprovalDecision(analysis, autoApproveEnabled);
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (requiresApproval) {
      await this.persistUiEvent(sessionId, 'requestToolApproval', {
        id: approvalId,
        command,
        cwd,
        severity,
        reason,
        status: 'pending',
        timestamp: Date.now()
      });
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

      // Don't send showToolAction for pending - let approval card handle it

      const approval = await this.waitForApproval(approvalId, token);
      if (!approval.approved) {
        const skippedOutput = 'Command skipped by user.';

        await this.persistUiEvent(sessionId, 'toolApprovalResult', {
          approvalId,
          status: 'skipped',
          output: skippedOutput
        });

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

      if (approval.command && approval.command.trim()) {
        args.command = approval.command.trim();
      }
      const finalCommand = String(args?.command || '').trim();

      // Don't send showToolAction for running - only final states via toolApprovalResult
    } else {
      await this.persistUiEvent(sessionId, 'toolApprovalResult', {
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

      // Don't send showToolAction for running - only final states via toolApprovalResult
    }

    const result = await this.toolRegistry.execute(resolvedToolName, args, context);
    const exitCodeMatch = (result.output || '').match(/Exit code:\s*(\d+)/i);
    const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : null;

    await this.persistUiEvent(sessionId, 'toolApprovalResult', {
      approvalId,
      status: 'approved',
      output: result.output,
      exitCode,
      command: String(args?.command || '').trim(),
      cwd
    });

    this.emitter.postMessage({
      type: 'toolApprovalResult',
      sessionId,
      approvalId,
      status: 'approved',
      output: result.output,
      exitCode,
      command: String(args?.command || '').trim()
    });

    return result;
  }

  private async executeFileEdit(
    toolName: string,
    args: any,
    context: any,
    sessionId: string,
    actionText: string,
    actionIcon: string,
    token: vscode.CancellationToken
  ) {
    const relPath = String(args?.path || args?.file || '').trim();
    if (!relPath) {
      throw new Error('No file path provided.');
    }

    const filePath = path.join(context.workspace.uri.fsPath, relPath);
    const uri = vscode.Uri.file(filePath);
    const workspaceRoot = context.workspace?.uri?.fsPath || '';
    const normalizedRelPath = workspaceRoot
      ? filePath.replace(workspaceRoot, '').replace(/^\//, '')
      : relPath;

    let originalContent = '';
    try {
      const existing = await vscode.workspace.fs.readFile(uri);
      originalContent = new TextDecoder().decode(existing);
    } catch {
      originalContent = '';
    }

    const newContent = String(args?.content ?? '');
    const sessionRecord = sessionId ? await this.databaseService.getSession(sessionId) : null;
    const autoApproveSensitiveEdits = !!sessionRecord?.auto_approve_sensitive_edits;
    const sessionPatterns = sessionRecord?.sensitive_file_patterns
      ? this.safeParsePatterns(sessionRecord.sensitive_file_patterns)
      : null;
    const settingsPatterns = this.getSettingsPatterns();
    const patterns = sessionPatterns || settingsPatterns || DEFAULT_SENSITIVE_FILE_PATTERNS;
    const decision = evaluateFileSensitivity(normalizedRelPath, patterns);

    const approvalId = `file_edit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const diffHtml = decision.requiresApproval
      ? renderDiffHtml(normalizedRelPath, originalContent, newContent)
      : '';

    if (decision.requiresApproval && autoApproveSensitiveEdits) {
      this.fileApprovalCache.set(approvalId, {
        filePath,
        displayPath: normalizedRelPath,
        originalContent,
        newContent
      });
      await this.persistFileEditApproval(sessionId, normalizedRelPath, originalContent, newContent, decision, true, 'approved', diffHtml);
      this.emitter.postMessage({
        type: 'fileEditApprovalResult',
        sessionId,
        approvalId,
        status: 'approved',
        autoApproved: true,
        filePath: normalizedRelPath,
        severity: decision.severity,
        reason: decision.reason,
        diffHtml
      });

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: normalizedRelPath,
        sessionId
      });
    } else if (decision.requiresApproval) {
      this.fileApprovalCache.set(approvalId, {
        filePath,
        displayPath: normalizedRelPath,
        originalContent,
        newContent
      });

      this.emitter.postMessage({
        type: 'requestFileEditApproval',
        sessionId,
        approval: {
          id: approvalId,
          filePath: normalizedRelPath,
          severity: decision.severity,
          reason: decision.reason,
          status: 'pending',
          timestamp: Date.now(),
          diffHtml
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

      const approval = await this.waitForApproval(approvalId, token);
      if (!approval.approved) {
        const skippedOutput = 'Edit skipped by user.';

        await this.persistFileEditApproval(sessionId, normalizedRelPath, originalContent, newContent, decision, false, 'skipped', diffHtml);
        this.emitter.postMessage({
          type: 'fileEditApprovalResult',
          sessionId,
          approvalId,
          status: 'skipped',
          autoApproved: false,
          filePath: normalizedRelPath,
          severity: decision.severity,
          reason: decision.reason,
          diffHtml
        });

        return {
          tool: toolName,
          input: args,
          output: skippedOutput,
          timestamp: Date.now()
        };
      }

      await this.persistFileEditApproval(sessionId, normalizedRelPath, originalContent, newContent, decision, false, 'approved', diffHtml);
      this.emitter.postMessage({
        type: 'fileEditApprovalResult',
        sessionId,
        approvalId,
        status: 'approved',
        autoApproved: false,
        filePath: normalizedRelPath,
        severity: decision.severity,
        reason: decision.reason,
        diffHtml
      });

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: normalizedRelPath,
        sessionId
      });
    } else {
      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: normalizedRelPath,
        sessionId
      });
    }

    const result = await this.toolRegistry.execute(toolName, args, context);
    return result;
  }

  async openFileDiff(approvalId: string): Promise<void> {
    const cached = this.fileApprovalCache.get(approvalId);
    if (!cached) {
      return;
    }

    const { filePath, displayPath, originalContent, newContent } = cached;
    await this.editManager.showDiff(
      vscode.Uri.file(filePath),
      originalContent,
      newContent,
      `Sensitive edit: ${displayPath}`
    );
  }

  private getSettingsPatterns(): Record<string, boolean> {
    const config = vscode.workspace.getConfiguration('ollamaCopilot');
    return config.get('agent.sensitiveFilePatterns', DEFAULT_SENSITIVE_FILE_PATTERNS);
  }

  private safeParsePatterns(raw: string): Record<string, boolean> | null {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as Record<string, boolean>;
    } catch {
      return null;
    }
  }

  private async persistFileEditApproval(
    sessionId: string,
    filePath: string,
    originalContent: string,
    newContent: string,
    decision: { severity: string; reason?: string },
    autoApproved: boolean,
    status: 'approved' | 'skipped',
    diffHtml: string
  ): Promise<void> {
    if (!sessionId) return;
    await this.databaseService.addMessage(sessionId, 'tool', diffHtml || '', {
      toolName: 'file_edit_approval',
      toolInput: JSON.stringify({
        path: filePath,
        originalContent,
        newContent,
        severity: decision.severity,
        reason: decision.reason,
        status,
        autoApproved
      }),
      toolOutput: diffHtml || ''
    });
  }

  private waitForApproval(
    approvalId: string,
    token: vscode.CancellationToken
  ): Promise<{ approved: boolean; command?: string }> {
    return new Promise(resolve => {
      const onCancel = token.onCancellationRequested(() => {
        onCancel.dispose();
        this.pendingApprovals.delete(approvalId);
        resolve({ approved: false });
      });

      this.pendingApprovals.set(approvalId, {
        resolve: (result: { approved: boolean; command?: string }) => {
          onCancel.dispose();
          resolve(result);
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
