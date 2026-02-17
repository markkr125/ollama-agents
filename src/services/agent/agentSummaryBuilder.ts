import * as vscode from 'vscode';
import { MessageRecord } from '../../types/session';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { DatabaseService } from '../database/databaseService';
import { OllamaClient } from '../model/ollamaClient';

// ---------------------------------------------------------------------------
// AgentSummaryBuilder — post-loop summary generation, final message
// persistence, and filesChanged emission. Extracted from AgentChatExecutor.
// ---------------------------------------------------------------------------

export interface SummaryResult {
  summary: string;
  assistantMessage: MessageRecord;
}

export class AgentSummaryBuilder {
  constructor(
    private readonly client: OllamaClient,
    private readonly databaseService: DatabaseService,
    private readonly emitter: WebviewMessageEmitter
  ) {}

  /**
   * Build the final assistant summary after the agent loop exits.
   *
   * Responsibilities:
   * 1. Generate a fallback LLM summary when no accumulated text exists
   * 2. Persist the final assistant message to the database
   * 3. Post `finalMessage` and `filesChanged` to the webview
   * 4. Return the summary + MessageRecord for the caller
   */
  async finalize(
    sessionId: string,
    model: string,
    agentSession: any,
    accumulatedExplanation: string,
    hasPersistedIterationText: boolean,
    currentCheckpointId: string | undefined,
    lastThinkingContent?: string
  ): Promise<SummaryResult> {
    const filesChanged = agentSession.filesChanged?.length || 0;

    // Build filesChanged payload (if any files were modified)
    let filesChangedPayload: {
      checkpointId: string;
      files: { path: string; action: string }[];
      status: string;
    } | null = null;
    if (filesChanged > 0 && currentCheckpointId) {
      const uniqueFiles = [...new Set(agentSession.filesChanged)] as string[];
      const fileInfos = uniqueFiles.map((fp: string) => ({ path: fp, action: 'modified' }));
      filesChangedPayload = { checkpointId: currentCheckpointId, files: fileInfos, status: 'pending' };
    }

    // If no explanation accumulated during streaming, ask the LLM for one.
    // The LLM summary is always preferred over the raw bullet list because it
    // produces a human-readable, actionable description of what was done.
    // The bullet list ("Summary of actions") is only used as a last resort
    // when the LLM call itself fails (e.g., connection error, empty response).
    let explanation = accumulatedExplanation;
    if (!explanation.trim()) {
      explanation = await this.generateFallbackSummary(model, agentSession, sessionId, lastThinkingContent);
    }

    // Last-resort fallback: raw tool bullet list (only if LLM summary failed)
    if (!explanation.trim()) {
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
      if (toolSummaryLines) {
        explanation = `Summary of actions:\n${toolSummaryLines}`;
      }
    }

    // Compose final summary
    let summary = filesChanged > 0
      ? `**${filesChanged} file${filesChanged > 1 ? 's' : ''} modified**\n\n`
      : '';
    summary += explanation || 'Task completed successfully.';

    // Persist final assistant message
    const summaryPrefix = filesChanged > 0
      ? `**${filesChanged} file${filesChanged > 1 ? 's' : ''} modified**\n\n`
      : '';
    const hasNewFinalContent = summaryPrefix || !hasPersistedIterationText;

    let assistantMessage: MessageRecord;
    if (hasNewFinalContent) {
      const finalContent = hasPersistedIterationText
        ? (summaryPrefix || 'Task completed successfully.')
        : summary;
      assistantMessage = await this.databaseService.addMessage(
        sessionId,
        'assistant',
        finalContent.trim(),
        { model }
      );
    } else {
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

    // Post final message to webview
    const finalMessageContent = hasPersistedIterationText ? (summaryPrefix.trim() || '') : summary;
    const cleanedFinal = (finalMessageContent || '').replace(/\[TASK_COMPLETE\]/gi, '').trim();
    if (cleanedFinal) {
      this.emitter.postMessage({ type: 'finalMessage', content: cleanedFinal, model, sessionId });
    }

    // Persist + post filesChanged
    if (filesChangedPayload) {
      await this.persistUiEvent(sessionId, 'filesChanged', filesChangedPayload);
      this.emitter.postMessage({ type: 'filesChanged', ...filesChangedPayload, sessionId });
    }

    this.emitter.postMessage({ type: 'hideThinking', sessionId });

    // Clean up scratch directory if it exists
    await this.cleanupScratchDirectory();

    return { summary, assistantMessage };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Call the LLM to generate a summary when the agent loop produced tool
   * results but no visible explanation text.
   */
  private async generateFallbackSummary(
    model: string,
    agentSession: any,
    sessionId: string,
    lastThinkingContent?: string
  ): Promise<string> {
    this.emitter.postMessage({ type: 'showThinking', message: 'Working...', sessionId });

    const toolResults = (agentSession.toolCalls || [])
      .slice(-6)
      .map((tool: any) =>
        `Tool: ${tool.tool || tool.name}\nOutput:\n${(tool.output || '').toString().slice(0, 2000)}`
      )
      .join('\n\n');

    // Include condensed thinking content for richer context.
    // When native tool calling returns empty content, thinking is the only
    // window into the model's reasoning about what it did and why.
    const thinkingContext = lastThinkingContent
      ? `\n\nAgent's reasoning (condensed):\n${lastThinkingContent.slice(0, 1500)}`
      : '';

    try {
      const finalStream = this.client.chat({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful coding assistant. Summarize what was accomplished in 2-4 sentences. Be specific: name files modified, functions changed, and what each change does. Use active voice, present tense. End with what the user should verify or test. Do not call tools.'
          },
          {
            role: 'user',
            content: `User request: ${agentSession.task}\n\nRecent tool results:\n${toolResults}${thinkingContext}\n\nProvide a specific, actionable summary of what was done.`
          }
        ]
      });

      let finalResponse = '';
      for await (const chunk of finalStream) {
        if (chunk.message?.content) {
          finalResponse += chunk.message.content;
        }
      }

      return finalResponse.trim();
    } catch {
      return '';
    } finally {
      this.emitter.postMessage({ type: 'hideThinking', sessionId });
    }
  }

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

  /**
   * Clean up the scratch directory created during agent execution.
   * The agent is instructed to use `.ollama-copilot-scratch/` for temp files.
   */
  private async cleanupScratchDirectory(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    const scratchUri = vscode.Uri.joinPath(folders[0].uri, '.ollama-copilot-scratch');
    try {
      await vscode.workspace.fs.stat(scratchUri);
      await vscode.workspace.fs.delete(scratchUri, { recursive: true });
    } catch {
      // Directory doesn't exist — nothing to clean up
    }
  }

  /**
   * Generate a short status line for the sessions list.
   * Format: 3-5 words, present tense (-ing), names a file or function.
   * E.g., "Fixing null check in validate.ts"
   */
  static generateStatusLine(toolCalls: any[]): string {
    if (!toolCalls?.length) return 'Working...';

    const last = toolCalls[toolCalls.length - 1];
    const toolName = last?.tool || last?.name || '';
    const args = last?.input || last?.args || {};
    const fileName = (args?.path || args?.file || '').split('/').pop() || '';

    switch (toolName) {
      case 'read_file':
        return fileName ? `Reading ${fileName}` : 'Reading file';
      case 'write_file':
      case 'create_file':
        return fileName ? `Writing ${fileName}` : 'Writing file';
      case 'search_workspace':
        return `Searching for "${(args?.query || '').slice(0, 20)}"`;
      case 'list_files':
        return 'Listing files';
      case 'run_terminal_command':
        return `Running command`;
      case 'find_definition':
        return args?.symbolName ? `Finding ${args.symbolName}` : 'Finding definition';
      case 'find_references':
        return args?.symbolName ? `Finding usages of ${args.symbolName}` : 'Finding references';
      case 'get_diagnostics':
        return fileName ? `Checking ${fileName}` : 'Checking diagnostics';
      case 'get_document_symbols':
        return fileName ? `Analyzing ${fileName}` : 'Getting symbols';
      default:
        return fileName ? `Processing ${fileName}` : 'Working...';
    }
  }
}
