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
    currentCheckpointId: string | undefined
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

    // Build tool summary lines for fallback
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

    // If no explanation accumulated during streaming, ask the LLM for one
    let explanation = accumulatedExplanation;
    if (!explanation.trim()) {
      explanation = await this.generateFallbackSummary(model, agentSession, sessionId);
    }

    if (!explanation.trim() && toolSummaryLines) {
      explanation = `Summary of actions:\n${toolSummaryLines}`;
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
    sessionId: string
  ): Promise<string> {
    this.emitter.postMessage({ type: 'showThinking', message: 'Working...', sessionId });

    const toolResults = (agentSession.toolCalls || [])
      .slice(-6)
      .map((tool: any) =>
        `Tool: ${tool.tool || tool.name}\nOutput:\n${(tool.output || '').toString().slice(0, 2000)}`
      )
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
}
