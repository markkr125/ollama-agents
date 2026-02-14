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
  /** Timestamp (ms) of the last thinking token received — used for accurate duration */
  lastThinkingTimestamp: number;
  /** Whether collapseThinking was already sent from inside the stream (on tool_call detection) */
  thinkingCollapsed: boolean;
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
    token: vscode.CancellationToken,
    thinkingStartTime?: number
  ): Promise<StreamResult> {
    let response = '';
    let thinkingContent = '';
    let lastThinkingTimestamp = 0;
    let thinkingCollapsed = false;
    const nativeToolCalls: OllamaToolCall[] = [];

    // Create an AbortController so we can abort the HTTP stream immediately
    // when the user clicks Stop. Without this, the `for await` loop blocks on
    // `reader.read()` until Ollama produces the next token — which can be
    // 30+ seconds during thinking. During that time `finalize()` can't run,
    // so `filesChanged` is never emitted.
    const abortController = new AbortController();
    const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

    const stream = this.client.chat(chatRequest, abortController.signal);

    this.emitter.postMessage({
      type: 'showThinking',
      message: iteration === 1 ? 'Thinking...' : 'Working...',
      sessionId
    });

    let textFrozen = false;
    let firstChunkReceived = false;
    let lastStreamTime = 0;

    try {
    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;

      // Accumulate thinking tokens
      if (chunk.message?.thinking) {
        thinkingContent += chunk.message.thinking;
        lastThinkingTimestamp = Date.now();
        this.emitter.postMessage({
          type: 'streamThinking',
          content: thinkingContent.replace(/\[TASK_COMPLETE\]/gi, ''),
          sessionId
        });
      }

      // Accumulate native tool calls
      if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
        nativeToolCalls.push(...chunk.message.tool_calls);
        // Tool calls arrived — thinking is definitely over.
        // Collapse thinking immediately with the real duration so the UI
        // stops showing "Thinking..." the instant we know tools are coming.
        if (!textFrozen) {
          textFrozen = true;
          if (thinkingContent && thinkingStartTime && lastThinkingTimestamp > 0) {
            const durationSeconds = Math.round((lastThinkingTimestamp - thinkingStartTime) / 1000);
            this.emitter.postMessage({ type: 'collapseThinking', sessionId, durationSeconds });
            thinkingCollapsed = true;
          }
          // Show what files are about to be written (extract from tool_call args)
          const writeFiles = chunk.message.tool_calls
            .filter((tc: any) => {
              const name = tc?.function?.name || '';
              return name === 'write_file' || name === 'create_file';
            })
            .map((tc: any) => {
              const p = tc?.function?.arguments?.path || tc?.function?.arguments?.file || '';
              return p ? p.split('/').pop() : '';
            })
            .filter(Boolean);
          const message = writeFiles.length > 0
            ? `Writing ${writeFiles.join(', ')}...`
            : 'Preparing tools...';
          this.emitter.postMessage({
            type: 'showThinking',
            message,
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
    } catch (err: any) {
      // AbortError is expected when the user clicks Stop — treat as clean exit
      if (err.name !== 'AbortError') {
        throw err;
      }
    } finally {
      cancelDisposable.dispose();
    }

    // Send final content state (no pending timer to flush anymore)

    // Always hide the thinking/generating spinner when the stream ends.
    // (It stays visible during streaming as a "still generating" indicator.)
    this.emitter.postMessage({ type: 'hideThinking', sessionId });

    return { response, thinkingContent, nativeToolCalls, firstChunkReceived, lastThinkingTimestamp, thinkingCollapsed };
  }
}
