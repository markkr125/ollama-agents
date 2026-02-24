import { structuredPatch } from 'diff';
import * as vscode from 'vscode';
import { DatabaseService } from '../../../services/database/databaseService';
import { PendingEditDecorationProvider } from '../../../services/review/pendingEditDecorationProvider';
import { ChatMessage } from '../../../types/ollama';
import { Session, ToolExecution } from '../../../types/session';
import { formatDiagnostics, getErrorDiagnostics, waitForDiagnostics } from '../../../utils/diagnosticWaiter';
import { getToolActionInfo, getToolSuccessInfo } from '../../../views/toolUIFormatter';
import { ToolRegistry } from '../../toolRegistry';
import { resolveMultiRootPath } from '../../tools/filesystem/pathUtils';
import { CHUNK_SIZE, countFileLines, readFileChunk } from '../../tools/filesystem/readFile';
import { AgentEventEmitter } from '../agentEventEmitter';
import { AgentFileEditHandler } from '../approval/agentFileEditHandler';
import { AgentTerminalHandler } from '../approval/agentTerminalHandler';
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
// Request object for executeBatch — replaces 10 positional params
// ---------------------------------------------------------------------------

export interface ToolBatchRequest {
  toolCalls: Array<{ name: string; args: any }>;
  context: any;
  sessionId: string;
  model: string;
  groupTitle: string;
  currentCheckpointId: string | undefined;
  agentSession: Session;
  useNativeTools: boolean;
  token: vscode.CancellationToken;
  messages?: ChatMessage[];
}

// ---------------------------------------------------------------------------
// AgentToolRunner — executes a batch of parsed tool calls within a single
// iteration. Handles routing to terminal / file‑edit / generic handlers,
// per-tool UI events, diff stats, and conversation history building.
// Extracted from AgentChatExecutor for single-responsibility.
// ---------------------------------------------------------------------------

export class AgentToolRunner {
  /** Cache of tool results keyed by `toolName:JSON(args)`. Prevents re-executing
   *  identical read-only tool calls across iterations. Write operations are never cached. */
  private readonly toolResultCache = new Map<string, string>();

  /** Tools whose output is deterministic within a session (no side effects). */
  private static readonly CACHEABLE_TOOLS = new Set([
    'search_workspace', 'list_files', 'find_definition', 'find_references',
    'find_symbol', 'get_document_symbols', 'get_hover_info', 'get_call_hierarchy',
    'find_implementations', 'get_type_hierarchy',
  ]);

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly databaseService: DatabaseService,
    private readonly terminalHandler: AgentTerminalHandler,
    private readonly fileEditHandler: AgentFileEditHandler,
    private readonly checkpointManager: CheckpointManager,
    private readonly decorationProvider: PendingEditDecorationProvider,
    private readonly refreshExplorer: () => void,
    private readonly onFileWritten?: (checkpointId: string) => void
  ) {}

  private events!: AgentEventEmitter;

  /** Bind the event emitter for the current session. Called once per execute() cycle. */
  bindEmitter(events: AgentEventEmitter): void {
    this.events = events;
    // Propagate to sub-handlers
    this.terminalHandler.bindEmitter(events);
    this.fileEditHandler.bindEmitter(events);
  }

  /**
   * Execute every tool call in `toolCalls`, emitting UI events and feeding
   * results back into the conversation history in the appropriate format.
   */
  async executeBatch(request: ToolBatchRequest): Promise<ToolBatchResult> {
    let { toolCalls, context, sessionId, model, groupTitle,
          currentCheckpointId, agentSession, useNativeTools, token, messages } = request;
    const nativeResults: ToolBatchResult['nativeResults'] = [];
    const xmlResults: string[] = [];
    let wroteFiles = false;

    // Over-eager mitigation: warn when a model requests too many tools per batch
    const TOOL_COUNT_WARN = 8;
    const TOOL_COUNT_HARD = 15;
    if (toolCalls.length > TOOL_COUNT_HARD) {
      // Hard limit: truncate and inject a stop-and-focus message
      const truncated = toolCalls.slice(0, TOOL_COUNT_HARD);
      const dropped = toolCalls.length - TOOL_COUNT_HARD;
      const warningMsg = `[SYSTEM NOTE: You requested ${toolCalls.length} tools in one batch — only the first ${TOOL_COUNT_HARD} were executed. ${dropped} were dropped. Break your work into smaller, focused iterations. Execute a few tools, review results, then continue.]`;
      toolCalls = truncated;
      if (useNativeTools) {
        nativeResults.push({ role: 'tool', content: warningMsg, tool_name: 'system' });
      } else {
        xmlResults.push(warningMsg);
      }
    } else if (toolCalls.length > TOOL_COUNT_WARN) {
      // Soft warning: still execute all, but inject a hint
      const warningMsg = `[SYSTEM NOTE: You requested ${toolCalls.length} tools in one batch. Consider using fewer, more targeted tool calls per iteration for better results.]`;
      if (useNativeTools) {
        nativeResults.push({ role: 'tool', content: warningMsg, tool_name: 'system' });
      } else {
        xmlResults.push(warningMsg);
      }
    }

    for (const toolCall of toolCalls) {
      if (token.isCancellationRequested) break;

      const { actionText, actionDetail, actionIcon } = getToolActionInfo(toolCall.name, toolCall.args);
      const isTerminalCommand = toolCall.name === 'run_terminal_command' || toolCall.name === 'run_command';
      const isFileEdit = toolCall.name === 'write_file' || toolCall.name === 'create_file';
      const isReadFile = toolCall.name === 'read_file';
      // Sub-agent creates its own dedicated wrapper progress group — skip
      // redundant running/success showToolAction events from the parent.
      const isSubagentCall = toolCall.name === 'run_subagent';

      // --- Tool result cache: return cached output for identical read-only calls ---
      const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;
      if (AgentToolRunner.CACHEABLE_TOOLS.has(toolCall.name)) {
        if (this.toolResultCache.has(cacheKey)) {
          const cached = this.toolResultCache.get(cacheKey)!;
          const cachePayload = { status: 'success' as const, icon: actionIcon, text: `${actionText} (cached)`, detail: 'Identical call — returning cached result' };
          await this.events.emit('showToolAction', cachePayload);

          if (useNativeTools) {
            nativeResults.push({ role: 'tool', content: cached, tool_name: toolCall.name });
          } else {
            xmlResults.push(`Tool result for ${toolCall.name}:\n${cached}`);
          }
          continue;
        }
      }

      // --- Chunked read_file handling ---
      // ALL read_file calls go through chunked streaming to avoid loading
      // the entire file into memory. Each chunk gets its own UI action.
      if (isReadFile) {
        try {
          const result = await this.executeChunkedRead(toolCall, context, sessionId, model, groupTitle, agentSession, useNativeTools);
          if (useNativeTools) {
            nativeResults.push({ role: 'tool', content: result, tool_name: toolCall.name });
          } else {
            xmlResults.push(`Tool result for ${toolCall.name}:\n${result}`);
          }
        } catch (error: any) {
          const errorPayload = {
            status: 'error' as const,
            icon: actionIcon,
            text: actionText,
            detail: error.message
          };
          await this.events.emit('showToolAction', errorPayload);
          agentSession.errors.push(error.message);
          if (sessionId) {
            await this.databaseService.addMessage(sessionId, 'tool', `Error: ${error.message}`, {
              model, toolName: toolCall.name,
              toolInput: JSON.stringify(toolCall.args),
              toolOutput: `Error: ${error.message}`,
              progressTitle: groupTitle
            });
          }
          if (useNativeTools) {
            nativeResults.push({ role: 'tool', content: `Error: ${error.message}`, tool_name: toolCall.name });
          } else {
            xmlResults.push(`Tool ${toolCall.name} failed: ${error.message}`);
          }
        }
        continue;
      }

      // Show "running" status for generic tools (terminal handler shows its own;
      // file edit handler emits its own with correct Creating/Editing verb;
      // sub-agent creates its own wrapper progress group)
      if (!isTerminalCommand && !isFileEdit && !isSubagentCall) {
        this.events.post('showToolAction', {
          status: 'running',
          icon: actionIcon,
          text: actionText,
          detail: actionDetail
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
            ? await this.fileEditHandler.execute(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token, model, messages)
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
              const absPath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
              this.decorationProvider.markPending(vscode.Uri.file(absPath));
            }

            // Emit incremental filesChanged so the widget updates in real-time
            if (currentCheckpointId) {
              const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
              const fileInfos = uniqueFiles.map((fp: string) => ({ path: fp, action: 'modified' }));
              this.events.post('filesChanged', {
                checkpointId: currentCheckpointId,
                files: fileInfos,
                status: 'pending'
              });

              // Trigger inline review (CodeLens) immediately after each write
              this.onFileWritten?.(currentCheckpointId);
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
          // Terminal commands already show skip in the approval card
          if (!isSkipped) {
            await this.events.emit('showToolAction', skipPayload);
          }

          // Tool denial tracking: tell the LLM not to retry the same call
          const denialHint = '\n\n[SYSTEM NOTE: This action was denied by the user. Do NOT re-attempt the same call. Adjust your approach or explain what you need and why.]';
          if (useNativeTools) {
            nativeResults.push({ role: 'tool', content: (result.output || 'Skipped by user') + denialHint, tool_name: toolCall.name });
          } else {
            xmlResults.push(`Tool ${toolCall.name} was denied by the user.${denialHint}`);
          }
        } else {
          // Build success action with diff stats
          const { actionText: successText, actionDetail: successDetail, filePath: successFilePath, startLine: successStartLine } =
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
            ...(successFilePath && currentCheckpointId ? { checkpointId: currentCheckpointId } : {}),
            ...(successStartLine != null ? { startLine: successStartLine } : {})
          };
          // Terminal commands already show result in the approval card;
          // sub-agent creates its own wrapper progress group
          if (!isTerminalCommand && !isSubagentCall) {
            await this.events.emit('showToolAction', actionPayload);
          }
        }

        // Feed tool result back to LLM — with contextual reminders + auto-diagnostics
        let autoDiagnosticsText = '';
        if (isFileEdit && !isSkipped && !isFileEditSkipped) {
          try {
            const relPath = String(toolCall.args?.path || toolCall.args?.file || '').trim();
            if (relPath) {
              const absPath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
              const fileUri = vscode.Uri.file(absPath);
              const diagnostics = await waitForDiagnostics(fileUri, 3000);
              const errors = getErrorDiagnostics(diagnostics);
              if (errors.length > 0) {
                autoDiagnosticsText = `\n\n[AUTO-DIAGNOSTICS] ${errors.length} error(s) detected after writing:\n${formatDiagnostics(errors)}`;
              }
            }
          } catch {
            // Non-critical — don't block on diagnostic failures
          }
        }

        const contextualHint = this.buildContextualReminder(toolCall.name, toolCall.args, result.output || '', isFileEdit, autoDiagnosticsText);
        const enrichedOutput = contextualHint ? (result.output || '') + contextualHint : (result.output || '');

        // Cache successful read-only tool results
        if (AgentToolRunner.CACHEABLE_TOOLS.has(toolCall.name)) {
          this.toolResultCache.set(cacheKey, result.output || '');
        }

        // Invalidate read_file cache entries when files are written
        // (the written file's content has changed, so cached reads are stale)
        if (isFileEdit && !isSkipped && !isFileEditSkipped) {
          const writtenPath = String(toolCall.args?.path || toolCall.args?.file || '');
          for (const [key] of this.toolResultCache) {
            if (key.startsWith('read_file:') && key.includes(writtenPath)) {
              this.toolResultCache.delete(key);
            }
          }
        }

        if (useNativeTools) {
          nativeResults.push({ role: 'tool', content: enrichedOutput, tool_name: toolCall.name });
        } else {
          xmlResults.push(`Tool result for ${toolCall.name}:\n${enrichedOutput}`);
        }
      } catch (error: any) {
        // Error UI + persistence (skip for terminal — approval card shows errors)
        const errorPayload = {
          status: 'error' as const,
          icon: actionIcon,
          text: actionText,
          detail: error.message
        };
        if (!isTerminalCommand) {
          await this.events.emit('showToolAction', errorPayload);
        }
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
  // Chunked read_file — streams a file in CHUNK_SIZE-line chunks, emitting
  // a UI action for each chunk. Returns the concatenated content.
  // -------------------------------------------------------------------------

  private async executeChunkedRead(
    toolCall: { name: string; args: any },
    context: any,
    sessionId: string,
    model: string,
    groupTitle: string,
    agentSession: Session,
    _useNativeTools: boolean
  ): Promise<string> {
    const relativePath = toolCall.args?.path || toolCall.args?.file || toolCall.args?.filePath;
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Missing required argument: path');
    }
    const absPath = resolveMultiRootPath(relativePath, context.workspace, context.workspaceFolders);
    const fileName = relativePath.split('/').pop() || relativePath;
    const totalLines = await countFileLines(absPath);

    const chunks: string[] = [];
    for (let start = 1; start <= totalLines; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, totalLines);

      // Emit "running" for this chunk
      const runPayload = {
        status: 'running' as const,
        icon: '📄',
        text: `Reading ${fileName}`,
        detail: `lines ${start}–${end}`,
        filePath: relativePath,
        startLine: start
      };
      this.events.post('showToolAction', runPayload);

      // Streaming read of just this chunk
      const chunkContent = await readFileChunk(absPath, start, end);
      chunks.push(chunkContent);

      // Emit "success" for this chunk
      const successPayload = {
        status: 'success' as const,
        icon: '📄',
        text: `Read ${fileName}`,
        detail: `lines ${start}–${end}`,
        filePath: relativePath,
        startLine: start
      };
      await this.events.emit('showToolAction', successPayload);
    }

    const combined = chunks.join('\n');

    // Persist the combined result to DB as a single tool message
    if (sessionId) {
      await this.databaseService.addMessage(sessionId, 'tool', combined, {
        model,
        toolName: toolCall.name,
        toolInput: JSON.stringify(toolCall.args),
        toolOutput: combined,
        progressTitle: groupTitle
      });
    }

    agentSession.toolCalls.push({ tool: toolCall.name, input: toolCall.args, output: combined, timestamp: Date.now() });
    return combined;
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

      const absPath = resolveMultiRootPath(relPath, context.workspace, context.workspaceFolders);
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

  // -------------------------------------------------------------------------
  // Contextual reminders — short hints appended to tool outputs before
  // feeding back to the LLM. Adapted from Claude Code's system reminders.
  // -------------------------------------------------------------------------

  private buildContextualReminder(toolName: string, args: any, output: string, isFileEdit: boolean, autoDiagnostics?: string): string {
    // Empty file reminder
    if (toolName === 'read_file' && output.trim() === '') {
      return '\n\n[Note: This file exists but is empty.]';
    }

    // File write success reminder — include auto-diagnostics if present
    if (isFileEdit && !output.toLowerCase().includes('skipped') && !output.toLowerCase().includes('error')) {
      if (autoDiagnostics) {
        return autoDiagnostics + '\n[Note: Fix these errors before continuing with other changes.]';
      }
      return '\n\n[Note: File modified successfully. Diagnostics check passed.]';
    }

    // Terminal command failure reminder
    if ((toolName === 'run_terminal_command' || toolName === 'run_command') && output.includes('Exit code:')) {
      const exitMatch = output.match(/Exit code:\s*(\d+)/);
      if (exitMatch && exitMatch[1] !== '0') {
        return '\n\n[Note: Command exited with a non-zero status. Investigate the error output before retrying with the same command.]';
      }
    }

    // Diagnostics with errors reminder
    if (toolName === 'get_diagnostics' && (output.includes('Error') || output.includes('error'))) {
      return '\n\n[Note: Errors detected. Review and fix these before continuing with other changes.]';
    }

    return '';
  }
}
