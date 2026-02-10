import { structuredPatch } from 'diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolRegistry } from '../../agent/toolRegistry';
import { ToolExecution } from '../../types/session';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { getToolActionInfo, getToolSuccessInfo } from '../../views/toolUIFormatter';
import { DatabaseService } from '../database/databaseService';
import { PendingEditDecorationProvider } from '../pendingEditDecorationProvider';
import { AgentFileEditHandler } from './agentFileEditHandler';
import { AgentTerminalHandler, PersistUiEventFn } from './agentTerminalHandler';
import { CheckpointManager } from './checkpointManager';

// ---------------------------------------------------------------------------
// Result of executing a batch of tool calls
// ---------------------------------------------------------------------------

export interface ToolBatchResult {
  /** Tool results formatted for native tool calling history */
  nativeResults: Array<{ role: 'tool'; content: string; tool_name: string }>;
  /** Tool results formatted for XML fallback history */
  xmlResults: string[];
  /** Whether any file write was performed (not skipped) */
  wroteFiles: boolean;
}

// ---------------------------------------------------------------------------
// AgentToolRunner — executes a batch of parsed tool calls within a single
// iteration. Handles routing to terminal / file‑edit / generic handlers,
// per-tool UI events, diff stats, and conversation history building.
// Extracted from AgentChatExecutor for single-responsibility.
// ---------------------------------------------------------------------------

export class AgentToolRunner {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly emitter: WebviewMessageEmitter,
    private readonly terminalHandler: AgentTerminalHandler,
    private readonly fileEditHandler: AgentFileEditHandler,
    private readonly checkpointManager: CheckpointManager,
    private readonly decorationProvider: PendingEditDecorationProvider,
    private readonly persistUiEvent: PersistUiEventFn,
    private readonly refreshExplorer: () => void
  ) {}

  /**
   * Execute every tool call in `toolCalls`, emitting UI events and feeding
   * results back into the conversation history in the appropriate format.
   */
  async executeBatch(
    toolCalls: Array<{ name: string; args: any }>,
    context: any,
    sessionId: string,
    model: string,
    groupTitle: string,
    currentCheckpointId: string | undefined,
    agentSession: any,
    useNativeTools: boolean,
    token: vscode.CancellationToken
  ): Promise<ToolBatchResult> {
    const nativeResults: ToolBatchResult['nativeResults'] = [];
    const xmlResults: string[] = [];
    let wroteFiles = false;

    for (const toolCall of toolCalls) {
      if (token.isCancellationRequested) break;

      const { actionText, actionDetail, actionIcon } = getToolActionInfo(toolCall.name, toolCall.args);
      const isTerminalCommand = toolCall.name === 'run_terminal_command' || toolCall.name === 'run_command';
      const isFileEdit = toolCall.name === 'write_file' || toolCall.name === 'create_file';

      // Show "running" status for generic tools (terminal/file handlers show their own)
      if (!isTerminalCommand && !isFileEdit) {
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
        // Snapshot file before write_file/create_file for undo support
        if (isFileEdit && currentCheckpointId) {
          await this.checkpointManager.snapshotFileBeforeEdit(toolCall.args, context, currentCheckpointId);
        }

        const result: ToolExecution = isTerminalCommand
          ? await this.terminalHandler.execute(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
          : isFileEdit
            ? await this.fileEditHandler.execute(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
            : await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
        agentSession.toolCalls.push(result);

        if (result.error) {
          throw new Error(result.error);
        }

        // Track file changes
        if (['write_file', 'create_file', 'delete_file'].includes(toolCall.name)) {
          const skippedEdit = (result.output || '').toLowerCase().includes('skipped by user');
          if (!skippedEdit) {
            agentSession.filesChanged.push(toolCall.args?.path || toolCall.args?.file);
            wroteFiles = true;
            this.refreshExplorer();

            const relPath = String(toolCall.args?.path || toolCall.args?.file || '');
            if (relPath) {
              const absPath = path.join(context.workspace?.uri?.fsPath || '', relPath);
              this.decorationProvider.markPending(vscode.Uri.file(absPath));
            }

            // Emit incremental filesChanged so the widget updates in real-time
            if (currentCheckpointId) {
              const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
              const fileInfos = uniqueFiles.map((fp: string) => ({ path: fp, action: 'modified' }));
              this.emitter.postMessage({
                type: 'filesChanged',
                checkpointId: currentCheckpointId,
                files: fileInfos,
                status: 'pending',
                sessionId
              });
            }
          }
        }

        // Persist tool result to DB
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

        // Handle skipped actions
        const isSkipped =
          (toolCall.name === 'run_terminal_command' || toolCall.name === 'run_command') &&
          (result.output || '').toLowerCase().includes('skipped by user');

        const isFileEditSkipped =
          (toolCall.name === 'write_file' || toolCall.name === 'create_file') &&
          (result.output || '').toLowerCase().includes('skipped by user');

        if (isSkipped || isFileEditSkipped) {
          const skipPayload = {
            status: 'error' as const,
            icon: actionIcon,
            text: isFileEditSkipped ? 'Edit skipped' : 'Command skipped',
            detail: 'Skipped by user'
          };
          this.emitter.postMessage({ type: 'showToolAction', ...skipPayload, sessionId });
          await this.persistUiEvent(sessionId, 'showToolAction', skipPayload);
        } else {
          // Build success action with diff stats
          const { actionText: successText, actionDetail: successDetail, filePath: successFilePath } =
            getToolSuccessInfo(toolCall.name, toolCall.args, result.output);

          let diffDetail = successDetail;
          if (isFileEdit && currentCheckpointId) {
            diffDetail = await this.computeInlineDiffStats(
              toolCall.args, context, currentCheckpointId, successDetail
            );
          }

          const actionPayload: any = {
            status: 'success',
            icon: actionIcon,
            text: successText,
            detail: diffDetail,
            ...(successFilePath ? { filePath: successFilePath } : {}),
            ...(successFilePath && currentCheckpointId ? { checkpointId: currentCheckpointId } : {})
          };
          this.emitter.postMessage({ type: 'showToolAction', ...actionPayload, sessionId });
          await this.persistUiEvent(sessionId, 'showToolAction', actionPayload);
        }

        // Feed tool result back to LLM
        if (useNativeTools) {
          nativeResults.push({ role: 'tool', content: result.output || '', tool_name: toolCall.name });
        } else {
          xmlResults.push(`Tool result for ${toolCall.name}:\n${result.output}`);
        }
      } catch (error: any) {
        // Error UI + persistence
        const errorPayload = {
          status: 'error' as const,
          icon: actionIcon,
          text: actionText,
          detail: error.message
        };
        this.emitter.postMessage({ type: 'showToolAction', ...errorPayload, sessionId });
        await this.persistUiEvent(sessionId, 'showToolAction', errorPayload);
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

        if (useNativeTools) {
          nativeResults.push({ role: 'tool', content: `Error: ${error.message}`, tool_name: toolCall.name });
        } else {
          xmlResults.push(`Tool ${toolCall.name} failed: ${error.message}`);
        }
      }
    }

    return { nativeResults, xmlResults, wroteFiles };
  }

  // -------------------------------------------------------------------------
  // Inline diff stats — computes +/- line counts for a file-edit action badge
  // -------------------------------------------------------------------------

  private async computeInlineDiffStats(
    args: any,
    context: any,
    checkpointId: string,
    fallback: string
  ): Promise<string> {
    try {
      const relPath = String(args?.path || args?.file || '').trim();
      const snapshot = await this.databaseService.getSnapshotForFile(checkpointId, relPath);
      if (!snapshot) return fallback;

      const absPath = path.join(context.workspace?.uri?.fsPath || '', relPath);
      const currentData = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
      const currentContent = new TextDecoder().decode(currentData);
      const original = snapshot.original_content ?? '';

      if (snapshot.action === 'created') {
        const lines = currentContent.split('\n').length;
        return `+${lines}`;
      }

      const patch = structuredPatch('a', 'b', original, currentContent, '', '', { context: 0 });
      let adds = 0, dels = 0;
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) adds++;
          else if (line.startsWith('-')) dels++;
        }
      }
      return `+${adds} -${dels}`;
    } catch {
      return fallback;
    }
  }
}
