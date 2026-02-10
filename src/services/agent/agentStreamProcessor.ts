import * as vscode from 'vscode';
import { ToolCall as OllamaToolCall } from '../../types/ollama';
import { detectPartialToolCall, removeToolCalls } from '../../utils/toolCallParser';
import { WebviewMessageEmitter } from '../../views/chatTypes';
import { OllamaClient } from '../model/ollamaClient';

// ---------------------------------------------------------------------------
// Result of a single streaming iteration
// ---------------------------------------------------------------------------

export interface StreamResult {
  /** Full accumulated response text from the model */
  response: string;
  /** Full accumulated thinking/chain-of-thought text */
  thinkingContent: string;
  /** Native tool calls collected during the stream */
  nativeToolCalls: OllamaToolCall[];
  /** Whether any text chunk was actually sent to the UI */
  firstChunkReceived: boolean;
}

// ---------------------------------------------------------------------------
// AgentStreamProcessor — owns the `for await (chunk)` loop and all throttled
// UI streaming logic. Extracted from AgentChatExecutor for single-responsibility.
// ---------------------------------------------------------------------------

const STREAM_THROTTLE_MS = 32;

export class AgentStreamProcessor {
  constructor(
    private readonly client: OllamaClient,
    private readonly emitter: WebviewMessageEmitter
  ) {}

  /**
   * Stream a single LLM chat iteration.
   *
   * Sends `showThinking`, `streamThinking`, `streamChunk`, and `hideThinking`
   * messages to the webview as chunks arrive. Returns the aggregated result.
   */
  async streamIteration(
    chatRequest: any,
    sessionId: string,
    model: string,
    iteration: number,
    useNativeTools: boolean,
    token: vscode.CancellationToken
  ): Promise<StreamResult> {
    let response = '';
    let thinkingContent = '';
    const nativeToolCalls: OllamaToolCall[] = [];

    const stream = this.client.chat(chatRequest);

    this.emitter.postMessage({
      type: 'showThinking',
      message: iteration === 1 ? 'Thinking...' : 'Working...',
      sessionId
    });

    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    let textFrozen = false;
    let firstChunkReceived = false;

    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;

      // Accumulate thinking tokens
      if (chunk.message?.thinking) {
        thinkingContent += chunk.message.thinking;
        this.emitter.postMessage({
          type: 'streamThinking',
          content: thinkingContent.replace(/\[TASK_COMPLETE\]/gi, ''),
          sessionId
        });
      }

      // Accumulate native tool calls
      if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
        nativeToolCalls.push(...chunk.message.tool_calls);
      }

      // Accumulate text content + throttled UI streaming
      if (chunk.message?.content) {
        response += chunk.message.content;

        if (!useNativeTools) {
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

        if (!textFrozen && !streamTimer) {
          streamTimer = setTimeout(() => {
            streamTimer = null;
            const latestCleaned = useNativeTools ? response : removeToolCalls(response);
            let latestText = latestCleaned.replace(/\[TASK_COMPLETE\]/gi, '');
            // Strip partial [TASK_COMPLETE] prefix at end of stream
            const TASK_MARKER = '[TASK_COMPLETE]';
            for (let len = TASK_MARKER.length - 1; len >= 1; len--) {
              if (latestText.toUpperCase().endsWith(TASK_MARKER.substring(0, len))) {
                latestText = latestText.slice(0, -len);
                break;
              }
            }
            latestText = latestText.trim();
            const wordCharCount = (latestText.match(/\w/g) || []).length;
            const isReady = firstChunkReceived
              ? (latestText.length > 0 && wordCharCount > 0)
              : (wordCharCount >= 8);
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

    // Flush any pending timer
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }

    if (!firstChunkReceived) {
      this.emitter.postMessage({ type: 'hideThinking', sessionId });
    }

    return { response, thinkingContent, nativeToolCalls, firstChunkReceived };
  }
}
