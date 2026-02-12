import * as path from 'path';
import * as vscode from 'vscode';
import { ToolRegistry } from '../../agent/toolRegistry';
import { PersistUiEventFn } from '../../types/agent';
import { renderDiffHtml } from '../../utils/diffRenderer';
import { DEFAULT_SENSITIVE_FILE_PATTERNS, evaluateFileSensitivity } from '../../utils/fileSensitivity';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { ApprovalManager } from './approvalManager';

// ---------------------------------------------------------------------------
// AgentFileEditHandler — file sensitivity check, approval flow, and
// execution for write_file/create_file. Extracted from AgentChatExecutor.
// ---------------------------------------------------------------------------

export class AgentFileEditHandler {
  /** Cache of file content for diff preview during approval flow. */
  readonly fileApprovalCache = new Map<string, { filePath: string; displayPath: string; originalContent: string; newContent: string }>();

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly editManager: EditManager,
    private readonly emitter: WebviewMessageEmitter,
    private readonly approvalManager: ApprovalManager,
    private readonly persistUiEvent: PersistUiEventFn,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  async execute(
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
    // Skip diff for new files — showing all lines as additions is not useful
    const diffHtml = decision.requiresApproval && originalContent
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
      await this.persistUiEvent(sessionId, 'fileEditApprovalResult', {
        approvalId,
        status: 'approved',
        autoApproved: true,
        filePath: normalizedRelPath,
        severity: decision.severity,
        reason: decision.reason,
        diffHtml
      });
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

      await this.persistUiEvent(sessionId, 'showToolAction', {
        status: 'pending',
        icon: actionIcon,
        text: actionText,
        detail: 'Awaiting approval'
      });

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'pending',
        icon: actionIcon,
        text: actionText,
        detail: 'Awaiting approval',
        sessionId
      });

      await this.persistUiEvent(sessionId, 'requestFileEditApproval', {
        id: approvalId,
        filePath: normalizedRelPath,
        severity: decision.severity,
        reason: decision.reason,
        status: 'pending',
        timestamp: Date.now(),
        diffHtml
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

      const approval = await this.approvalManager.waitForApproval(approvalId, token);
      if (!approval.approved) {
        const skippedOutput = 'Edit skipped by user.';

        await this.persistFileEditApproval(sessionId, normalizedRelPath, originalContent, newContent, decision, false, 'skipped', diffHtml);
        await this.persistUiEvent(sessionId, 'fileEditApprovalResult', {
          approvalId,
          status: 'skipped',
          autoApproved: false,
          filePath: normalizedRelPath,
          severity: decision.severity,
          reason: decision.reason,
          diffHtml
        });
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
      await this.persistUiEvent(sessionId, 'fileEditApprovalResult', {
        approvalId,
        status: 'approved',
        autoApproved: false,
        filePath: normalizedRelPath,
        severity: decision.severity,
        reason: decision.reason,
        diffHtml
      });
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

      await this.persistUiEvent(sessionId, 'showToolAction', {
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: normalizedRelPath
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
      await this.persistUiEvent(sessionId, 'showToolAction', {
        status: 'running',
        icon: actionIcon,
        text: actionText,
        detail: normalizedRelPath
      });
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

  /**
   * Open diff view for a cached file approval entry.
   */
  async openFileDiff(approvalId: string): Promise<void> {
    const cached = this.fileApprovalCache.get(approvalId);
    if (!cached) return;

    const { filePath, displayPath, originalContent, newContent } = cached;
    await this.editManager.showDiff(
      vscode.Uri.file(filePath),
      originalContent,
      newContent,
      `Sensitive edit: ${displayPath}`
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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
}
