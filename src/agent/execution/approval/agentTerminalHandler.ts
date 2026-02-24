import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseService } from '../../../services/database/databaseService';
import { ToolRegistry } from '../../toolRegistry';
import { AgentEventEmitter } from '../agentEventEmitter';
import { ApprovalManager } from './approvalManager';
import { analyzeDangerousCommand } from './commandSafety';
import { computeTerminalApprovalDecision } from './terminalApproval';

// ---------------------------------------------------------------------------
// AgentTerminalHandler — terminal command safety check, approval flow, and
// execution. Extracted from AgentChatExecutor for single-responsibility.
// ---------------------------------------------------------------------------

export class AgentTerminalHandler {
  private events!: AgentEventEmitter;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly approvalManager: ApprovalManager,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  /** Bind the event emitter for the current session. Called once per execute() cycle. */
  bindEmitter(events: AgentEventEmitter): void {
    this.events = events;
  }

  async execute(
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

    // Resolve cwd: always relative to workspace root.
    const workspaceRoot = context.workspace.uri.fsPath;
    let cwd = workspaceRoot;
    if (args?.cwd && typeof args.cwd === 'string' && args.cwd.trim()) {
      const rawCwd = args.cwd.trim();
      const resolved = path.isAbsolute(rawCwd)
        ? rawCwd
        : path.resolve(workspaceRoot, rawCwd);
      if (resolved.startsWith(workspaceRoot)) {
        cwd = resolved;
      }
    }
    const resolvedToolName = toolName === 'run_command' ? 'run_terminal_command' : toolName;
    const analysis = analyzeDangerousCommand(command);
    const sessionRecord = sessionId ? await this.databaseService.getSession(sessionId) : null;
    const autoApproveEnabled = !!sessionRecord?.auto_approve_commands;
    const { requiresApproval, severity, reason } = computeTerminalApprovalDecision(analysis, autoApproveEnabled);
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (requiresApproval) {
      const approvalPayload = {
        id: approvalId,
        command,
        cwd,
        severity,
        reason,
        status: 'pending',
        timestamp: Date.now()
      };
      await this.events.emit('requestToolApproval', { approval: approvalPayload, ...approvalPayload });

      const approval = await this.approvalManager.waitForApproval(approvalId, token);
      if (!approval.approved) {
        const skippedOutput = 'Command skipped by user.';

        await this.events.emit('toolApprovalResult', {
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

      // Emit 'running' state so the webview keeps the spinner while the command executes
      await this.events.emit('toolApprovalResult', {
        approvalId,
        status: 'running',
        command: String(args?.command || '').trim(),
        cwd
      });
    } else {
      await this.events.emit('toolApprovalResult', {
        approvalId,
        status: 'running',
        output: 'Auto-approved for this session.',
        autoApproved: true,
        command,
        cwd,
        severity,
        reason
      });
    }

    const result = await this.toolRegistry.execute(resolvedToolName, args, context);
    const exitCodeMatch = (result.output || '').match(/Exit code:\s*(\d+)/i);
    const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : null;

    await this.events.emit('toolApprovalResult', {
      approvalId,
      status: 'approved',
      output: result.output,
      exitCode,
      command: String(args?.command || '').trim(),
      cwd
    });

    return result;
  }
}
