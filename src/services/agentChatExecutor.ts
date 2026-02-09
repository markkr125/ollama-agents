import { structuredPatch } from 'diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExecutorConfig } from '../agent/executor';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { getConfig } from '../config/settings';
import { DatabaseService } from '../services/databaseService';
import { ModelCapabilities } from '../services/modelCompatibility';
import { OllamaClient } from '../services/ollamaClient';
import { TerminalManager } from '../services/terminalManager';
import { ToolCall as OllamaToolCall } from '../types/ollama';
import { MessageRecord, ToolExecution } from '../types/session';
import { analyzeDangerousCommand } from '../utils/commandSafety';
import { renderDiffHtml } from '../utils/diffRenderer';
import { DEFAULT_SENSITIVE_FILE_PATTERNS, evaluateFileSensitivity } from '../utils/fileSensitivity';
import { computeTerminalApprovalDecision } from '../utils/terminalApproval';
import { detectPartialToolCall, extractToolCalls, removeToolCalls } from '../utils/toolCallParser';
import { WebviewMessageEmitter } from '../views/chatTypes';
import { getProgressGroupTitle, getToolActionInfo, getToolSuccessInfo } from '../views/toolUIFormatter';
import { EditManager } from './editManager';
import { PendingEditDecorationProvider } from './pendingEditDecorationProvider';

export class AgentChatExecutor {
  private pendingApprovals = new Map<string, { resolve: (result: { approved: boolean; command?: string }) => void }>();

  async persistUiEvent(
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
    private readonly terminalManager: TerminalManager,
    private readonly decorationProvider: PendingEditDecorationProvider
  ) {
    this.editManager = new EditManager(this.client);
  }

  handleToolApprovalResponse(approvalId: string, approved: boolean, command?: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    pending.resolve({ approved, command });
    this.pendingApprovals.delete(approvalId);
  }

  /**
   * Persist + post a git branch creation as a full progress group.
   * Called from chatView.ts so session history matches live chat.
   */
  async persistGitBranchAction(sessionId: string, branchName: string): Promise<void> {
    const title = 'Git setup';
    await this.persistUiEvent(sessionId, 'startProgressGroup', { title });
    this.emitter.postMessage({ type: 'startProgressGroup', title, sessionId });

    const action = { status: 'success' as const, icon: '📌', text: `Created branch: ${branchName}`, detail: branchName };
    await this.persistUiEvent(sessionId, 'showToolAction', action);
    this.emitter.postMessage({ type: 'showToolAction', ...action, sessionId });

    await this.persistUiEvent(sessionId, 'finishProgressGroup', {});
    this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
  }

  async execute(
    agentSession: any,
    config: ExecutorConfig,
    token: vscode.CancellationToken,
    sessionId: string,
    model: string,
    capabilities?: ModelCapabilities
  ): Promise<{ summary: string; assistantMessage: MessageRecord }> {
    const context = {
      workspace: agentSession.workspace,
      token,
      outputChannel: this.outputChannel,
      sessionId,
      terminalManager: this.terminalManager
    };

    const useNativeTools = !!capabilities?.tools;
    const { agent: agentConfig } = getConfig();
    const useThinking = agentConfig.enableThinking && useNativeTools;

    // Build system prompt — for native tool calling, a simpler prompt suffices
    const workspacePath = agentSession.workspace?.uri?.fsPath || '';
    const systemContent = useNativeTools
      ? `You are a coding agent. Use the provided tools to complete tasks. The workspace root is: ${workspacePath}. All file paths are relative to this workspace. Terminal commands run in this directory by default. When done, respond with [TASK_COMPLETE].`
      : this.buildAgentSystemPrompt();

    const messages: any[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: agentSession.task }
    ];

    // Warn if model doesn't support native tool calling
    if (!useNativeTools) {
      this.emitter.postMessage({
        type: 'showWarningBanner',
        message: 'This model doesn\'t natively support tool calling. Agent mode will use text-based tool parsing, which may be less reliable. Consider using a model like llama3.1+, qwen2.5+, or mistral.',
        sessionId
      });
    }

    let iteration = 0;
    let accumulatedExplanation = '';
    let hasWrittenFiles = false;
    let hasPersistedIterationText = false;

    // Create a checkpoint for this agent request (for undo/redo file tracking)
    let currentCheckpointId: string | undefined;
    try {
      currentCheckpointId = await this.databaseService.createCheckpoint(sessionId);
    } catch (err) {
      console.warn('[AgentChatExecutor] Failed to create checkpoint:', err);
    }

    // Check if task likely requires file modifications
    const taskLower = agentSession.task.toLowerCase();
    const taskRequiresWrite = /\b(rename|change|modify|edit|update|add|create|write|fix|refactor|remove|delete)\b/.test(taskLower);

    // Streaming throttle (same as chatView.ts handleChatMode — 32ms ~30fps)
    const STREAM_THROTTLE_MS = 32;

    while (iteration < config.maxIterations && !token.isCancellationRequested) {
      iteration++;

      try {
        let response = '';
        let thinkingContent = '';
        let nativeToolCalls: OllamaToolCall[] = [];

        // Build the chat request
        const chatRequest: any = { model, messages };
        if (useNativeTools) {
          chatRequest.tools = this.toolRegistry.getOllamaToolDefinitions();
        }
        if (useThinking) {
          chatRequest.think = true;
        }

        const stream = this.client.chat(chatRequest);

        this.emitter.postMessage({
          type: 'showThinking',
          message: iteration === 1 ? 'Thinking...' : 'Working...',
          sessionId
        });

        // Stream tokens in real time
        let streamTimer: ReturnType<typeof setTimeout> | null = null;
        let textFrozen = false; // For XML fallback: freeze text display once tool_call tag detected
        let firstChunkReceived = false;

        for await (const chunk of stream) {
          if (token.isCancellationRequested) break;

          // Handle thinking tokens (from think=true)
          if (chunk.message?.thinking) {
            thinkingContent += chunk.message.thinking;
            // Stream thinking tokens live (transient — final content persisted after)
            // Strip [TASK_COMPLETE] control signal from displayed thinking content
            this.emitter.postMessage({
              type: 'streamThinking',
              content: thinkingContent.replace(/\[TASK_COMPLETE\]/gi, ''),
              sessionId
            });
          }

          // Handle native tool_calls from the API
          if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
            // Ollama sends each tool call as a complete object in its own chunk.
            // Just accumulate them — no dedup needed (dedup would silently drop
            // legitimate duplicate calls with identical name+args).
            nativeToolCalls.push(...chunk.message.tool_calls);
          }

          // Handle text content
          if (chunk.message?.content) {
            response += chunk.message.content;

            if (!useNativeTools) {
              // XML fallback: check for partial tool call tag
              const partialTool = detectPartialToolCall(response);
              if (partialTool && !textFrozen) {
                textFrozen = true;
                this.emitter.postMessage({
                  type: 'showThinking',
                  message: `Preparing to use ${partialTool}...`,
                  sessionId
                });
              }
            }

            // Stream text to UI in real time (throttled), unless frozen for XML tool detection.
            // The timer callback reads `response` at FIRE time (not set time) so it always
            // sends the latest accumulated text — avoids showing stale partial markdown like "**".
            if (!textFrozen && !streamTimer) {
              streamTimer = setTimeout(() => {
                streamTimer = null;
                const latestCleaned = useNativeTools ? response : removeToolCalls(response);
                // Strip full [TASK_COMPLETE] AND any trailing partial prefix of it
                // (tokens arrive incrementally, so timer may fire when text ends with "[TASK" etc.)
                let latestText = latestCleaned.replace(/\[TASK_COMPLETE\]/gi, '');
                const TASK_MARKER = '[TASK_COMPLETE]';
                for (let len = TASK_MARKER.length - 1; len >= 1; len--) {
                  if (latestText.toUpperCase().endsWith(TASK_MARKER.substring(0, len))) {
                    latestText = latestText.slice(0, -len);
                    break;
                  }
                }
                latestText = latestText.trim();
                // Gate the FIRST chunk more strictly to avoid showing partial markdown
                // like "**What" (bold not yet closed). Once we've started streaming,
                // show everything — the renderer handles partial content with prior context.
                // First-chunk gate: require ≥ 8 word characters (e.g. "**What i" has 5 → wait).
                const wordCharCount = (latestText.match(/\w/g) || []).length;
                const isReady = firstChunkReceived
                  ? (latestText.length > 0 && wordCharCount > 0) // after first: any word content
                  : (wordCharCount >= 8);                        // first chunk: need a real phrase
                if (latestText && isReady) {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    this.emitter.postMessage({ type: 'hideThinking', sessionId });
                  }
                  this.emitter.postMessage({
                    type: 'streamChunk',
                    content: latestText,
                    model,
                    sessionId
                  });
                }
              }, STREAM_THROTTLE_MS);
            }
          }
        }

        // Flush any pending throttled update
        if (streamTimer) {
          clearTimeout(streamTimer);
          streamTimer = null;
        }

        // Hide thinking spinner if still visible (e.g. model produced no text content)
        if (!firstChunkReceived) {
          this.emitter.postMessage({ type: 'hideThinking', sessionId });
        }

        if (token.isCancellationRequested) {
          this.sessionManager.updateSession(agentSession.id, { status: 'cancelled' });
          break;
        }

        // Debug: Log the full LLM response for troubleshooting
        this.outputChannel.appendLine(`\n[Iteration ${iteration}] Full LLM response:`);
        this.outputChannel.appendLine(response);
        if (thinkingContent) {
          this.outputChannel.appendLine(`[Thinking] ${thinkingContent.substring(0, 500)}`);
        }
        if (nativeToolCalls.length > 0) {
          this.outputChannel.appendLine(`[Native tool_calls] ${JSON.stringify(nativeToolCalls)}`);
        }
        this.outputChannel.appendLine('---');

        // De-duplicate: some models echo thinking content in response too
        if (thinkingContent.trim() && response.trim()) {
          const thinkTrimmed = thinkingContent.trim();
          const respTrimmed = response.trim();
          if (respTrimmed === thinkTrimmed ||
              respTrimmed.startsWith(thinkTrimmed) ||
              thinkTrimmed.startsWith(respTrimmed)) {
            response = '';
          }
        }

        // Persist thinking block if present (BEFORE text and tools — order matters for history)
        // Strip [TASK_COMPLETE] control signal — it's an internal marker, not user-facing content
        const displayThinking = thinkingContent.replace(/\[TASK_COMPLETE\]/gi, '').trim();
        if (displayThinking) {
          await this.persistUiEvent(sessionId, 'thinkingBlock', { content: displayThinking });
          // Collapse it now that streaming is done
          this.emitter.postMessage({
            type: 'collapseThinking',
            sessionId
          });
        }

        // Process explanation text — per-iteration delta (NOT accumulated)
        const cleanedText = useNativeTools ? response.trim() : removeToolCalls(response);
        const iterationDelta = cleanedText.trim();

        if (iterationDelta && !iterationDelta.includes('[TASK_COMPLETE]')) {
          if (accumulatedExplanation) {
            accumulatedExplanation += '\n\n';
          }
          accumulatedExplanation += iterationDelta;

          // Send per-iteration delta text (NOT accumulated — each iteration is its own text block)
          this.emitter.postMessage({
            type: 'streamChunk',
            content: iterationDelta,
            model,
            sessionId
          });

          // Persist this iteration's delta text (for ALL iterations, not just tool iterations)
          if (sessionId) {
            await this.databaseService.addMessage(
              sessionId,
              'assistant',
              iterationDelta,
              { model }
            );
            hasPersistedIterationText = true;
          }
        }

        if (response.includes('[TASK_COMPLETE]') || response.toLowerCase().includes('task is complete')) {
          // Validate: if task required writes but none happened, reject completion
          if (taskRequiresWrite && !hasWrittenFiles) {
            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: 'You said the task is complete, but no files were modified. You must use write_file to actually make changes. Reading a file does not modify it. Please complete the task by calling write_file with the modified content.'
            });
            continue;
          }
          const completionText = cleanedText.replace(/\[TASK_COMPLETE\]/gi, '').trim();
          accumulatedExplanation = completionText || accumulatedExplanation;

          // Persist this iteration's text — the throttled stream already showed it,
          // but the DB needs it so hasPersistedIterationText is correct and
          // finalMessage doesn't duplicate the full explanation.
          if (completionText && sessionId) {
            await this.databaseService.addMessage(sessionId, 'assistant', completionText, { model });
            hasPersistedIterationText = true;
          }
          break;
        }

        // Extract tool calls — dual path: native API vs XML text parsing
        let toolCalls: Array<{ name: string; args: any }> = [];

        if (useNativeTools && nativeToolCalls.length > 0) {
          // Native path: structured tool_calls from the Ollama API
          toolCalls = nativeToolCalls.map(tc => ({
            name: tc.function?.name || '',
            args: tc.function?.arguments || {}
          }));
        } else {
          // XML fallback path: parse <tool_call> blocks from text
          toolCalls = extractToolCalls(response);
        }

        // Debug: Log parsed tool calls
        this.outputChannel.appendLine(`[Iteration ${iteration}] Parsed ${toolCalls.length} tool calls (${useNativeTools ? 'native' : 'XML'}):`);
        toolCalls.forEach((tc, i) => this.outputChannel.appendLine(`  [${i}] ${tc.name}: ${JSON.stringify(tc.args)}`));
        this.outputChannel.appendLine('---');

        if (toolCalls.length === 0) {
          // Include thinking so the model retains its chain-of-thought context
          const noToolMsg: any = { role: 'assistant', content: response };
          if (thinkingContent) noToolMsg.thinking = thinkingContent;
          messages.push(noToolMsg);
          if (iteration < config.maxIterations - 1) {
            messages.push({
              role: 'user',
              content: 'Continue with the task. Use tools or respond with [TASK_COMPLETE] if finished.'
            });
          }
          continue;
        }

        // NOTE: Per-iteration text is already persisted above (for ALL iterations).
        // No duplicate assistant message persist needed here.

        const groupTitle = getProgressGroupTitle(toolCalls);
        this.emitter.postMessage({
          type: 'startProgressGroup',
          title: groupTitle,
          sessionId
        });
        await this.persistUiEvent(sessionId, 'startProgressGroup', { title: groupTitle });

        // Sequential tool execution — parallel deferred (approval flow requires sequential).
        // See docs/chat-and-modes.md for rationale.
        //
        // IMPORTANT: Push the assistant message ONCE before the loop, not per-tool.
        // Pushing it inside the loop would duplicate the assistant message for every tool call,
        // destroying the model's context and causing "forgetful" behavior.
        if (useNativeTools) {
          // Per Ollama streaming docs: include thinking + content + tool_calls
          const assistantMsg: any = { role: 'assistant', content: response, tool_calls: nativeToolCalls };
          if (thinkingContent) assistantMsg.thinking = thinkingContent;
          messages.push(assistantMsg);
        } else {
          const assistantMsg: any = { role: 'assistant', content: response };
          if (thinkingContent) assistantMsg.thinking = thinkingContent;
          messages.push(assistantMsg);
        }

        const xmlToolResults: string[] = []; // XML fallback: accumulate results, push once after loop

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
            // Snapshot file before write_file/create_file for undo support
            if (isFileEdit && currentCheckpointId) {
              await this.snapshotFileBeforeEdit(toolCall.args, context, currentCheckpointId);
            }

            const result: ToolExecution = isTerminalCommand
              ? await this.executeTerminalCommand(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
              : isFileEdit
                ? await this.executeFileEdit(toolCall.name, toolCall.args, context, sessionId, actionText, actionIcon, token)
                : await this.toolRegistry.execute(toolCall.name, toolCall.args, context);
            agentSession.toolCalls.push(result);

            // Check if the tool returned an error
            if (result.error) {
              throw new Error(result.error);
            }

            if (['write_file', 'create_file', 'delete_file'].includes(toolCall.name)) {
              const skippedEdit = (result.output || '').toLowerCase().includes('skipped by user');
              if (!skippedEdit) {
                agentSession.filesChanged.push(toolCall.args?.path || toolCall.args?.file);
                hasWrittenFiles = true;
                this.refreshExplorer();

                // Mark file as pending in Explorer/tab decorations
                const relPath = String(toolCall.args?.path || toolCall.args?.file || '');
                if (relPath) {
                  const absPath = path.join(context.workspace?.uri?.fsPath || '', relPath);
                  this.decorationProvider.markPending(vscode.Uri.file(absPath));
                }

                // Emit incremental filesChanged so the widget updates in real-time
                // (not persisted — only the final batch is persisted after the loop)
                if (currentCheckpointId) {
                  const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
                  const fileInfos = uniqueFiles.map(fp => ({ path: fp, action: 'modified' }));
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
              const { actionText: successText, actionDetail: successDetail, filePath: successFilePath } =
                getToolSuccessInfo(toolCall.name, toolCall.args, result.output);

              // Compute quick diff stats for file writes
              let diffDetail = successDetail;
              if (isFileEdit && currentCheckpointId) {
                try {
                  const relPath = String(toolCall.args?.path || toolCall.args?.file || '').trim();
                  const snapshot = await this.databaseService.getSnapshotForFile(currentCheckpointId, relPath);
                  if (snapshot) {
                    const absPath = path.join(context.workspace?.uri?.fsPath || '', relPath);
                    const currentData = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
                    const currentContent = new TextDecoder().decode(currentData);
                    const original = snapshot.original_content ?? '';
                    if (snapshot.action === 'created') {
                      const lines = currentContent.split('\n').length;
                      diffDetail = `+${lines}`;
                    } else {
                      const patch = structuredPatch('a', 'b', original, currentContent, '', '', { context: 0 });
                      let adds = 0, dels = 0;
                      for (const hunk of patch.hunks) {
                        for (const line of hunk.lines) {
                          if (line.startsWith('+')) adds++;
                          else if (line.startsWith('-')) dels++;
                        }
                      }
                      diffDetail = `+${adds} -${dels}`;
                    }
                  }
                } catch { /* diff stats are optional */ }
              }

              const actionPayload: any = {
                status: 'success',
                icon: actionIcon,
                text: successText,
                detail: diffDetail,
                ...(successFilePath ? { filePath: successFilePath } : {}),
                ...(successFilePath && currentCheckpointId ? { checkpointId: currentCheckpointId } : {})
              };
              this.emitter.postMessage({
                type: 'showToolAction',
                ...actionPayload,
                sessionId
              });
              await this.persistUiEvent(sessionId, 'showToolAction', actionPayload);
            }

            // Feed tool result back to LLM
            if (useNativeTools) {
              // Native: one tool message per result (assistant message already pushed before loop)
              // Include tool_name so the model knows which tool produced which result
              messages.push({ role: 'tool', content: result.output || '', tool_name: toolCall.name });
            } else {
              // XML fallback: accumulate results, push one user message after loop
              xmlToolResults.push(`Tool result for ${toolCall.name}:\n${result.output}`);
            }
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

            // Feed error back to LLM
            if (useNativeTools) {
              messages.push({ role: 'tool', content: `Error: ${error.message}`, tool_name: toolCall.name });
            } else {
              xmlToolResults.push(`Tool ${toolCall.name} failed: ${error.message}`);
            }
          }
        }

        // Finish the progress group after processing all tool calls in this iteration
        this.emitter.postMessage({ type: 'finishProgressGroup', sessionId });
        await this.persistUiEvent(sessionId, 'finishProgressGroup', {});

        // XML fallback: push all accumulated tool results as one user message
        if (!useNativeTools && xmlToolResults.length > 0) {
          messages.push({
            role: 'user',
            content: xmlToolResults.join('\n\n') + '\n\nContinue with the task.'
          });
        }
      } catch (error: any) {
        // Persist error so session history matches live chat
        await this.persistUiEvent(sessionId, 'showError', { message: error.message });
        this.emitter.postMessage({ type: 'showError', message: error.message, sessionId });
        break;
      }
    }

    this.sessionManager.updateSession(agentSession.id, { status: 'completed' });

    // Count changed files (payload will be emitted AFTER finalMessage so the
    // widget is always the last block in the assistant thread).
    const filesChanged = agentSession.filesChanged?.length || 0;
    let filesChangedPayload: { checkpointId: string; files: { path: string; action: string }[]; status: string } | null = null;
    if (filesChanged > 0 && currentCheckpointId) {
      const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
      const fileInfos = uniqueFiles.map(fp => {
        // Determine action: 'created' if the file didn't exist before, 'modified' otherwise
        return { path: fp, action: 'modified' };
      });
      filesChangedPayload = {
        checkpointId: currentCheckpointId,
        files: fileInfos,
        status: 'pending'
      };
    }

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

    // Only persist the final message if there's NEW content not already saved per-iteration.
    // The summary prefix ("N files modified") and fallback text are new; the per-iteration
    // deltas were already persisted inside the loop. This prevents duplicate text blocks
    // in session history (CRITICAL RULE #1: live must match restored).
    const summaryPrefix = filesChanged > 0 ? `**${filesChanged} file${filesChanged > 1 ? 's' : ''} modified**\n\n` : '';
    const hasNewFinalContent = summaryPrefix || !hasPersistedIterationText;

    let assistantMessage: MessageRecord;
    if (hasNewFinalContent) {
      // Persist only what hasn't been saved yet
      const finalContent = hasPersistedIterationText
        ? (summaryPrefix || 'Task completed successfully.')  // Only the prefix/fallback
        : summary;                                            // Full text if nothing was saved
      assistantMessage = await this.databaseService.addMessage(
        sessionId,
        'assistant',
        finalContent.trim(),
        { model }
      );
    } else {
      // Everything was already persisted — just build the return value
      assistantMessage = {
        id: `msg_${Date.now()}`,
        session_id: sessionId,
        role: 'assistant',
        content: summary,
        model,
        created_at: new Date().toISOString(),
        timestamp: Date.now()
      } as MessageRecord;
    }

    // finalMessage: send ONLY new content (summary prefix or fallback).
    // Per-iteration text blocks already exist in the webview — don't overwrite them.
    const finalMessageContent = hasPersistedIterationText ? (summaryPrefix.trim() || '') : summary;
    if (finalMessageContent) {
      this.emitter.postMessage({ type: 'finalMessage', content: finalMessageContent, model, sessionId });
    }

    // Emit filesChanged AFTER finalMessage so the widget is the last block
    // in the assistant thread (not sandwiched between text blocks).
    if (filesChangedPayload) {
      await this.persistUiEvent(sessionId, 'filesChanged', filesChangedPayload);
      this.emitter.postMessage({ type: 'filesChanged', ...filesChangedPayload, sessionId });
    }

    this.emitter.postMessage({ type: 'hideThinking', sessionId });

    return { summary, assistantMessage };
  }

  /**
   * Snapshot a file's content BEFORE a write_file/create_file tool edits it.
   * Uses INSERT OR IGNORE so only the first (true original) snapshot is kept per checkpoint.
   */
  private async snapshotFileBeforeEdit(
    args: any,
    context: any,
    checkpointId: string
  ): Promise<void> {
    try {
      const relPath = String(args?.path || args?.file || '').trim();
      if (!relPath) return;

      const workspaceRoot = context.workspace?.uri?.fsPath || '';
      const absPath = path.join(workspaceRoot, relPath);
      const uri = vscode.Uri.file(absPath);

      let originalContent: string | null = null;
      let action = 'modified';

      try {
        const existing = await vscode.workspace.fs.readFile(uri);
        originalContent = new TextDecoder().decode(existing);
      } catch {
        // File doesn't exist yet — this is a creation
        originalContent = null;
        action = 'created';
      }

      await this.databaseService.insertFileSnapshot(checkpointId, relPath, originalContent, action);
    } catch (err) {
      console.warn('[AgentChatExecutor] Failed to snapshot file before edit:', err);
    }
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

    // Resolve cwd: always relative to workspace root.
    // If the model sends an absolute path outside the workspace or "/", clamp to workspace root.
    const workspaceRoot = context.workspace.uri.fsPath;
    let cwd = workspaceRoot;
    if (args?.cwd && typeof args.cwd === 'string' && args.cwd.trim()) {
      const rawCwd = args.cwd.trim();
      const resolved = path.isAbsolute(rawCwd)
        ? rawCwd
        : path.resolve(workspaceRoot, rawCwd);
      // Only allow if resolved path is inside the workspace
      if (resolved.startsWith(workspaceRoot)) {
        cwd = resolved;
      }
      // Otherwise stays clamped to workspaceRoot
    }
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
      // Persist the auto-approved file edit result
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

      // Persist pending action FIRST, then approval card - ORDER MATTERS for history reconstruction
      await this.persistUiEvent(sessionId, 'showToolAction', {
        status: 'pending',
        icon: actionIcon,
        text: actionText,
        detail: 'Awaiting approval'
      });

      // Send pending action to UI - this ensures LIVE matches SESSION (both show pending → approved/skipped)
      this.emitter.postMessage({
        type: 'showToolAction',
        status: 'pending',
        icon: actionIcon,
        text: actionText,
        detail: 'Awaiting approval',
        sessionId
      });

      // Now persist the file edit approval request
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

      const approval = await this.waitForApproval(approvalId, token);
      if (!approval.approved) {
        const skippedOutput = 'Edit skipped by user.';

        await this.persistFileEditApproval(sessionId, normalizedRelPath, originalContent, newContent, decision, false, 'skipped', diffHtml);
        // Persist the skipped file edit result
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
      // Persist the approved file edit result
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

      // Persist running action - this ensures SESSION matches LIVE (both show pending AND running→success)
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
      // Non-sensitive file - also persist running action for consistency
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

  // ---------------------------------------------------------------------------
  // Files Changed — Keep / Undo / Diff
  // ---------------------------------------------------------------------------

  /**
   * Open a diff view for a file from a checkpoint snapshot.
   */
  async openFileChangeDiff(checkpointId: string, filePath: string): Promise<void> {
    const snapshot = await this.databaseService.getSnapshotForFile(checkpointId, filePath);
    if (!snapshot) {
      vscode.window.showWarningMessage(`No snapshot found for ${filePath}`);
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const absPath = path.join(workspaceRoot, filePath);
    const fileUri = vscode.Uri.file(absPath);

    const originalContent = snapshot.original_content ?? '';
    await this.editManager.showDiff(
      fileUri,
      originalContent,
      undefined as any, // Will read current file content
      `AI changes: ${filePath}`
    );
  }

  /**
   * Open a diff between the snapshot's original_content and the current file on disk.
   * Uses a custom content provider to serve the original content.
   */
  async openSnapshotDiff(checkpointId: string | undefined, filePath: string, sessionId?: string): Promise<void> {
    let snapshot = checkpointId
      ? await this.databaseService.getSnapshotForFile(checkpointId, filePath)
      : null;

    // Fallback: search session checkpoints for this file if direct lookup failed
    if (!snapshot && sessionId) {
      const checkpoints = await this.databaseService.getCheckpoints(sessionId);
      for (const cp of checkpoints) {
        snapshot = await this.databaseService.getSnapshotForFile(cp.id, filePath);
        if (snapshot) break;
      }
    }

    if (!snapshot) {
      vscode.window.showWarningMessage(`No snapshot found for ${filePath}`);
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const absPath = path.join(workspaceRoot, filePath);
    const currentUri = vscode.Uri.file(absPath);

    const originalContent = snapshot.original_content ?? '';
    let currentContent = '';
    try {
      const data = await vscode.workspace.fs.readFile(currentUri);
      currentContent = new TextDecoder().decode(data);
    } catch {
      currentContent = '';
    }

    await this.editManager.showDiff(
      currentUri,
      originalContent,
      currentContent,
      `AI changes: ${filePath}`
    );
  }

  /**
   * Keep a single file's changes (mark as accepted).
   */
  async keepFile(checkpointId: string, filePath: string): Promise<{ success: boolean }> {
    await this.databaseService.updateFileSnapshotStatus(checkpointId, filePath, 'kept');

    // Clear decoration for this file
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const absPath = path.join(workspaceRoot, filePath);
    this.decorationProvider.clearPending(vscode.Uri.file(absPath));

    // Update checkpoint status based on remaining file statuses
    await this.updateCheckpointStatusFromFiles(checkpointId);
    return { success: true };
  }

  /**
   * Undo a single file's changes (revert to original).
   */
  async undoFile(checkpointId: string, filePath: string): Promise<{ success: boolean }> {
    const snapshot = await this.databaseService.getSnapshotForFile(checkpointId, filePath);
    if (!snapshot || snapshot.original_content === null) {
      return { success: false };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const absPath = path.join(workspaceRoot, filePath);
    const uri = vscode.Uri.file(absPath);

    try {
      if (snapshot.action === 'created') {
        // File was created by the agent — delete it
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } else {
        // File was modified — restore original content
        const edit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(uri, fullRange, snapshot.original_content);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
      }
    } catch (err: any) {
      console.warn(`[undoFile] Failed to revert ${filePath}:`, err);
      return { success: false };
    }

    await this.databaseService.updateFileSnapshotStatus(checkpointId, filePath, 'undone');
    this.decorationProvider.clearPending(uri);
    this.refreshExplorer();

    await this.updateCheckpointStatusFromFiles(checkpointId);
    return { success: true };
  }

  /**
   * Mark a file as undone in the DB + clear decoration, WITHOUT reverting file content.
   * Used by the inline review service which already reverted the file on disk.
   */
  async markFileUndone(checkpointId: string, filePath: string): Promise<void> {
    await this.databaseService.updateFileSnapshotStatus(checkpointId, filePath, 'undone');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const absPath = path.join(workspaceRoot, filePath);
    this.decorationProvider.clearPending(vscode.Uri.file(absPath));

    await this.updateCheckpointStatusFromFiles(checkpointId);
  }

  /**
   * Keep all file changes in a checkpoint.
   */
  async keepAllChanges(checkpointId: string): Promise<{ success: boolean }> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    for (const snap of snapshots) {
      if (snap.file_status === 'pending') {
        await this.databaseService.updateFileSnapshotStatus(checkpointId, snap.file_path, 'kept');
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
        const absPath = path.join(workspaceRoot, snap.file_path);
        this.decorationProvider.clearPending(vscode.Uri.file(absPath));
      }
    }
    await this.databaseService.updateCheckpointStatus(checkpointId, 'kept');
    // Prune original_content blobs to free storage
    await this.databaseService.pruneKeptCheckpointContent(checkpointId);
    return { success: true };
  }

  /**
   * Undo all file changes in a checkpoint.
   */
  async undoAllChanges(checkpointId: string): Promise<{ success: boolean; errors: string[] }> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const errors: string[] = [];

    const edit = new vscode.WorkspaceEdit();
    const filesToDelete: vscode.Uri[] = [];

    for (const snap of snapshots) {
      if (snap.file_status !== 'pending') continue;
      if (snap.original_content === null) continue;

      const absPath = path.join(workspaceRoot, snap.file_path);
      const uri = vscode.Uri.file(absPath);

      try {
        if (snap.action === 'created') {
          filesToDelete.push(uri);
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );
          edit.replace(uri, fullRange, snap.original_content);
        }
      } catch (err: any) {
        errors.push(`${snap.file_path}: ${err.message}`);
      }
    }

    // Apply all text replacements atomically
    const editSuccess = await vscode.workspace.applyEdit(edit);
    if (!editSuccess) {
      errors.push('WorkspaceEdit.applyEdit failed');
    }

    // Delete created files
    for (const uri of filesToDelete) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch (err: any) {
        errors.push(`Delete ${uri.fsPath}: ${err.message}`);
      }
    }

    // Save all modified documents
    for (const snap of snapshots) {
      if (snap.file_status !== 'pending' || snap.action === 'created') continue;
      try {
        const absPath = path.join(workspaceRoot, snap.file_path);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
        if (doc?.isDirty) await doc.save();
      } catch { /* best effort */ }
    }

    // Update all statuses
    for (const snap of snapshots) {
      if (snap.file_status === 'pending') {
        await this.databaseService.updateFileSnapshotStatus(checkpointId, snap.file_path, 'undone');
        const absPath = path.join(workspaceRoot, snap.file_path);
        this.decorationProvider.clearPending(vscode.Uri.file(absPath));
      }
    }

    await this.databaseService.updateCheckpointStatus(checkpointId, 'undone');
    this.refreshExplorer();
    return { success: errors.length === 0, errors };
  }

  /**
   * Compute diff stats for all files in a checkpoint (original vs current on disk).
   */
  async computeFilesDiffStats(checkpointId: string): Promise<Array<{ path: string; additions: number; deletions: number; action: string }>> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
    const results: Array<{ path: string; additions: number; deletions: number; action: string }> = [];

    for (const snap of snapshots) {
      const absPath = path.join(workspaceRoot, snap.file_path);
      let currentContent = '';
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        currentContent = new TextDecoder().decode(data);
      } catch {
        currentContent = '';
      }

      const original = snap.original_content ?? '';

      // Use proper diff algorithm for accurate line-level stats
      let additions = 0;
      let deletions = 0;

      const patch = structuredPatch('a', 'b', original, currentContent, '', '', { context: 0 });
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) additions++;
          else if (line.startsWith('-')) deletions++;
        }
      }

      results.push({
        path: snap.file_path,
        additions,
        deletions,
        action: snap.action
      });
    }

    return results;
  }

  /**
   * Update the checkpoint status based on the aggregate file statuses.
   */
  private async updateCheckpointStatusFromFiles(checkpointId: string): Promise<void> {
    const snapshots = await this.databaseService.getFileSnapshots(checkpointId);
    const statuses = new Set(snapshots.map(s => s.file_status));

    let newStatus: string;
    if (statuses.size === 1) {
      newStatus = statuses.has('kept') ? 'kept' : statuses.has('undone') ? 'undone' : 'pending';
    } else if (statuses.has('pending')) {
      newStatus = 'partial';
    } else {
      newStatus = 'partial';
    }

    await this.databaseService.updateCheckpointStatus(checkpointId, newStatus);
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
    const toolDescriptions = tools.map((t: { name: string; description: string; schema?: any }) => {
      const params = t.schema?.properties
        ? Object.entries(t.schema.properties)
            .map(([key, val]: [string, any]) => `    ${key}: ${val.description || val.type}`)
            .join('\n')
        : '    (no parameters)';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n');

    return `You are a coding agent. You MUST use tools to complete tasks. Never claim to do something without using tools.

TOOLS:
${toolDescriptions}

FORMAT - Always use this exact format:
<tool_call>{"name": "TOOL_NAME", "arguments": {"arg": "value"}}</tool_call>

EXAMPLES:
<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>
<tool_call>{"name": "write_file", "arguments": {"path": "file.txt", "content": "new content"}}</tool_call>

CRITICAL: To edit a file you must call write_file. Reading alone does NOT change files.

When done: [TASK_COMPLETE]`;
  }
}
