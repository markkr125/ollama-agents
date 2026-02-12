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

    let textFrozen = false;
    let firstChunkReceived = false;
    let lastStreamTime = 0;

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
        // Show a transient indicator so the user knows tools are being prepared
        // (native tool call tokens generate silently — no content tokens fire)
        if (!textFrozen) {
          textFrozen = true;
          this.emitter.postMessage({
            type: 'showThinking',
            message: 'Preparing tools...',
            sessionId
          });
        }
      }

      // Accumulate text content + throttled UI streaming.
      // IMPORTANT: Throttle uses synchronous Date.now() comparison instead of
      // setTimeout. The `for await` loop creates microtasks that starve the
      // macrotask queue — setTimeout callbacks never fire when the model is
      // fast. Synchronous gating avoids this entirely.
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

        const now = Date.now();
        if (!textFrozen && now - lastStreamTime >= STREAM_THROTTLE_MS) {
          lastStreamTime = now;
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
              this.emitter.postMessage({
                type: 'showThinking',
                message: 'Generating...',
                sessionId
              });
            }
            this.emitter.postMessage({
              type: 'streamChunk',
              content: latestText,
              model,
              sessionId
            });
          }
        }
      }
    }

    // Send final content state (no pending timer to flush anymore)

    // Always hide the thinking/generating spinner when the stream ends.
    // (It stays visible during streaming as a "still generating" indicator.)
    this.emitter.postMessage({ type: 'hideThinking', sessionId });

    return { response, thinkingContent, nativeToolCalls, firstChunkReceived };
  }
}
