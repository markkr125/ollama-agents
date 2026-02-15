import * as path from 'path';
import * as vscode from 'vscode';
import { ToolRegistry } from '../../agent/toolRegistry';
import { resolveMultiRootPath } from '../../agent/tools/pathUtils';
import { PersistUiEventFn } from '../../types/agent';
import { ChatMessage, ChatRequest } from '../../types/ollama';
import { renderDiffHtml } from '../../utils/diffRenderer';
import { DEFAULT_SENSITIVE_FILE_PATTERNS, evaluateFileSensitivity } from '../../utils/fileSensitivity';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { DatabaseService } from '../database/databaseService';
import { EditManager } from '../editManager';
import { OllamaClient } from '../model/ollamaClient';
import { ApprovalManager } from './approvalManager';

// ---------------------------------------------------------------------------
// AgentFileEditHandler — file sensitivity check, approval flow, and
// execution for write_file/create_file. Extracted from AgentChatExecutor.
//
// Supports **deferred content generation**: when a tool call provides
// `description` but no `content`, makes a separate streaming LLM call to
// generate the file content. This avoids Ollama's silent 60-80s buffering
// of tool_call JSON for large files — the spinner shows "Writing file..."
// immediately when the tool is invoked.
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
    private readonly outputChannel: vscode.OutputChannel,
    private readonly client: OllamaClient
  ) {}

  async execute(
    toolName: string,
    args: any,
    context: any,
    sessionId: string,
    actionText: string,
    actionIcon: string,
    token: vscode.CancellationToken,
    model?: string,
    messages?: ChatMessage[]
  ) {
    const relPath = String(args?.path || args?.file || '').trim();
    if (!relPath) {
      throw new Error('No file path provided.');
    }

    const filePath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
    const uri = vscode.Uri.file(filePath);
    const normalizedRelPath = vscode.workspace.asRelativePath(uri, true);

    let originalContent = '';
    try {
      const existing = await vscode.workspace.fs.readFile(uri);
      originalContent = new TextDecoder().decode(existing);
    } catch {
      originalContent = '';
    }

    // Tag args so downstream success handlers know if this was a create or edit
    const isNew = !originalContent;
    args._isNew = isNew;

    // Emit the running action with the correct verb (Creating vs Editing)
    // Must happen BEFORE deferred content generation so the UI isn't empty.
    const fileName = relPath.split('/').pop() || relPath;
    const runningText = isNew ? `Creating ${fileName}` : `Editing ${fileName}`;
    await this.persistUiEvent(sessionId, 'showToolAction', {
      status: 'running',
      icon: actionIcon,
      text: runningText,
      detail: ''
    });
    this.emitter.postMessage({
      type: 'showToolAction',
      status: 'running',
      icon: actionIcon,
      text: runningText,
      detail: '',
      sessionId
    });

    // -----------------------------------------------------------------------
    // Deferred content generation: when the model provides `description` but
    // no `content`, make a separate streaming LLM call to produce the file.
    // This avoids Ollama buffering the entire file inside a tool_call JSON.
    // -----------------------------------------------------------------------
    let newContent: string;
    const hasDescription = typeof args?.description === 'string' && args.description.trim();
    const hasContent = typeof args?.content === 'string' && args.content.trim();

    if (!hasContent && hasDescription && model) {
      newContent = await this.generateDeferredContent(
        model, relPath, args.description, originalContent, messages, token
      );
      // Patch args.content so the downstream toolRegistry.execute() writes it
      args.content = newContent;
    } else {
      newContent = String(args?.content ?? '');
    }

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
        text: runningText,
        detail: 'Awaiting approval'
      });

      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'pending',
        icon: actionIcon,
        text: runningText,
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

  /**
   * Generate file content via a separate streaming LLM call.
   *
   * The main agent loop receives only `{ path, description }` from the tool
   * call (tiny, instant). This method builds a focused prompt and streams
   * the actual file content from the model, accumulating it token-by-token.
   */
  private async generateDeferredContent(
    model: string,
    relPath: string,
    description: string,
    originalContent: string,
    conversationMessages?: ChatMessage[],
    token?: vscode.CancellationToken
  ): Promise<string> {
    const isEdit = !!originalContent;
    const ext = path.extname(relPath).slice(1);

    // Build a focused system prompt — the model should output ONLY file content
    const systemPrompt = [
      `You are a code generator. Output ONLY the complete file content for "${relPath}" — no markdown fences, no explanations, no surrounding text.`,
      ext ? `The file type is ${ext}.` : '',
      isEdit
        ? 'The user wants to MODIFY the existing file. Apply the described changes to the original content below and output the full updated file.'
        : 'The user wants to CREATE a new file. Generate the full file content based on the description.',
    ].filter(Boolean).join(' ');

    // Build the user message with the description + original content (if editing)
    const userParts: string[] = [`Description of ${isEdit ? 'changes' : 'content'}: ${description}`];
    if (isEdit) {
      userParts.push(`\nOriginal file content:\n\`\`\`\n${originalContent}\n\`\`\``);
    }

    // Include a condensed task context from the last user message in the conversation
    if (conversationMessages?.length) {
      const lastUser = [...conversationMessages].reverse().find(m => m.role === 'user');
      if (lastUser?.content) {
        const truncated = lastUser.content.length > 2000
          ? lastUser.content.slice(0, 2000) + '…'
          : lastUser.content;
        userParts.push(`\nTask context:\n${truncated}`);
      }
    }

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userParts.join('\n') }
    ];

    const request: ChatRequest = {
      model,
      messages: chatMessages,
      stream: true,
      options: { temperature: 0.2 }
    };

    this.outputChannel.appendLine(`[Deferred write] Generating content for ${relPath} (model: ${model})`);

    let accumulated = '';
    try {
      for await (const chunk of this.client.chat(request)) {
        if (token?.isCancellationRequested) {
          this.outputChannel.appendLine(`[Deferred write] Cancelled for ${relPath}`);
          break;
        }
        const delta = chunk.message?.content;
        if (delta) {
          accumulated += delta;
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[Deferred write] Error for ${relPath}: ${error.message}`);
      throw new Error(`Failed to generate content for ${relPath}: ${error.message}`);
    }

    // Strip markdown code fences the model may wrap around content despite instructions
    accumulated = this.stripCodeFences(accumulated);

    this.outputChannel.appendLine(`[Deferred write] Generated ${accumulated.split('\n').length} lines for ${relPath}`);
    return accumulated;
  }

  /** Strip leading/trailing markdown code fences (```lang ... ```) if present. */
  private stripCodeFences(text: string): string {
    const trimmed = text.trim();
    const fenceStart = /^```[\w]*\n?/;
    const fenceEnd = /\n?```\s*$/;
    if (fenceStart.test(trimmed) && fenceEnd.test(trimmed)) {
      return trimmed.replace(fenceStart, '').replace(fenceEnd, '');
    }
    return trimmed;
  }
}
