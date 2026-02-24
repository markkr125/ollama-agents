import { MessageRecord } from '../../types/session';
import { buildConversationHistory, stripThinkingFromHistory } from './agentLoopHelpers';

// ---------------------------------------------------------------------------
// ConversationHistory — typed wrapper around the agent's `messages[]` array.
//
// Provides typed methods for every kind of message push, ensuring the Ollama
// conversation protocol is followed correctly:
//   - Thinking is NEVER included in history (Pitfall #12)
//   - Tool results use `role:'tool'` + `tool_name` in native mode
//   - No-tool assistant messages always set content (prevents blank-turn amnesia)
//   - System notes are ephemeral and cleaned between iterations
//
// The class exposes the raw `messages` array for backward compatibility with
// helpers that accept `messages: any[]`, but all new message additions should
// go through the typed methods.
// ---------------------------------------------------------------------------

export class ConversationHistory {
  /**
   * The underlying messages array. Exposed for backward compatibility with
   * existing helpers (`buildChatRequest`, `compactAndEmit`, etc.) that
   * accept `messages: any[]`. Prefer typed methods for new additions.
   */
  readonly messages: any[];

  private readonly _useNativeTools: boolean;

  constructor(options: {
    systemPrompt: string;
    conversationHistory: MessageRecord[];
    userTask: string;
    useNativeTools: boolean;
  }) {
    this._useNativeTools = options.useNativeTools;
    const historyMessages = buildConversationHistory(
      options.conversationHistory, options.useNativeTools
    );
    this.messages = [
      { role: 'system', content: options.systemPrompt },
      ...historyMessages,
      { role: 'user', content: options.userTask }
    ];
  }

  /** Whether this history is configured for native tool calling. */
  get useNativeTools(): boolean { return this._useNativeTools; }

  /** Number of messages in the history. */
  get length(): number { return this.messages.length; }

  // ── Message Addition Methods ──────────────────────────────────────────

  /**
   * Add a no-tool assistant message. Used when the model responds without
   * any tool calls. Uses `[Reasoning completed]` as fallback content when
   * the response is empty but thinking was produced (prevents blank-turn
   * amnesia for templates that only render `{{ .Content }}`).
   */
  addAssistantMessage(response: string, thinkingContent: string): void {
    this.messages.push({
      role: 'assistant',
      content: response || (thinkingContent ? '[Reasoning completed]' : '')
    });
  }

  /**
   * Add an assistant message WITH tool calls. Builds the content from the
   * tool summary (preferred), response text, or a thinking fallback.
   * In XML mode, appends a `[Called: ...]` annotation for history tracking.
   *
   * Returns the constructed assistant message object (for DB persistence).
   */
  addAssistantToolMessage(opts: {
    toolCalls: Array<{ name: string; args: any }>;
    nativeToolCalls: Array<{ function?: { name?: string; arguments?: any } }>;
    response: string;
    thinkingContent: string;
    toolSummary?: string;
  }): any {
    const { toolCalls, nativeToolCalls, response, thinkingContent, toolSummary } = opts;
    let assistantContent = toolSummary || response || (thinkingContent ? '[Reasoning completed]' : '');

    if (!this._useNativeTools && toolCalls.length > 0) {
      const callDescs = toolCalls.map(tc => {
        const argParts = Object.entries(tc.args || {})
          .filter(([k]) => k !== 'content')
          .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v.substring(0, 100)}"` : JSON.stringify(v)}`)
          .join(', ');
        return `${tc.name}(${argParts})`;
      }).join(', ');
      assistantContent = assistantContent
        ? `${assistantContent}\n\n[Called: ${callDescs}]`
        : `[Called: ${callDescs}]`;
    }

    const assistantMsg: any = { role: 'assistant', content: assistantContent };
    if (this._useNativeTools) assistantMsg.tool_calls = nativeToolCalls;
    this.messages.push(assistantMsg);
    return assistantMsg;
  }

  /**
   * Add native `role:'tool'` results. Each result is a separate message
   * with `tool_name` set, matching the Ollama API specification.
   * Only valid when `useNativeTools` is true.
   */
  addNativeToolResults(results: Array<{ content: string; tool_name: string }>): void {
    for (const r of results) {
      this.messages.push({ role: 'tool', content: r.content, tool_name: r.tool_name });
    }
  }

  /**
   * Add XML-mode tool results as a single `role:'user'` message.
   * Results are joined with double newlines, followed by the continuation.
   * Only used when `useNativeTools` is false.
   */
  addXmlToolResults(results: string[], continuation: string): void {
    this.messages.push({
      role: 'user',
      content: results.join('\n\n') + '\n\n' + continuation
    });
  }

  /**
   * Add a continuation / probe message (role:'user'). Used after tool
   * results to tell the model what to do next, or to prompt for
   * `[TASK_COMPLETE]`.
   */
  addContinuation(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  /**
   * Add an ephemeral system note. These are one-iteration signals
   * (external file modifications, IDE focus changes, token warnings)
   * and should be cleaned at the start of the next iteration via
   * `cleanStaleSystemNotes()`.
   */
  addSystemNote(note: string): void {
    this.messages.push({
      role: 'user',
      content: `[SYSTEM NOTE: ${note}]`
    });
  }

  // ── Lifecycle Methods ─────────────────────────────────────────────────

  /**
   * Remove all ephemeral `[SYSTEM NOTE:]` messages. Call at the start of
   * each iteration (after the first) to prevent stale context from
   * accumulating.
   */
  cleanStaleSystemNotes(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && typeof m.content === 'string' &&
          m.content.startsWith('[SYSTEM NOTE:')) {
        this.messages.splice(i, 1);
      }
    }
  }

  /**
   * Update the system prompt content in place. Used to inject session
   * memory reminders or update context between iterations.
   */
  updateSystemPrompt(transform: (current: string) => string): void {
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0].content = transform(this.messages[0].content);
    }
  }

  /**
   * Strip `thinking` from all history messages and return the messages
   * array for building a chat request. Per Ollama #10448 / Qwen3 docs:
   * "No Thinking Content in History".
   *
   * MUST be called before building a chat request to ensure compliance.
   */
  prepareForRequest(): any[] {
    stripThinkingFromHistory(this.messages);
    return this.messages;
  }
}
