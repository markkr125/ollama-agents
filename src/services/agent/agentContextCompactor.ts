import { OllamaClient } from '../model/ollamaClient';

// ---------------------------------------------------------------------------
// AgentContextCompactor — summarizes conversation history when it grows too
// long, preserving critical context while freeing token budget. Inspired by
// Claude Code's context-compaction-summary pattern.
// ---------------------------------------------------------------------------

/** Rough token estimate: word count × 1.3. Not exact, but sufficient for threshold checks. */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

function estimateMessagesTokens(messages: any[]): number {
  return messages.reduce((sum, m) => {
    let text = m.content || '';
    if (m.thinking) text += m.thinking;
    return sum + estimateTokens(text);
  }, 0);
}

// ---------------------------------------------------------------------------
// Token category breakdown — used by the token usage indicator UI
// ---------------------------------------------------------------------------

export interface TokenCategoryBreakdown {
  system: number;
  toolDefinitions: number;
  messages: number;
  toolResults: number;
  files: number;
  total: number;
}

/**
 * Estimate token usage by category from the current conversation state.
 * When `actualPromptTokens` is available, scales the heuristic estimates
 * proportionally so category percentages are accurate to real usage.
 */
export function estimateTokensByCategory(
  messages: any[],
  toolDefinitionCount?: number,
  actualPromptTokens?: number
): TokenCategoryBreakdown {
  let system = 0;
  let msgs = 0;
  let toolResults = 0;
  let files = 0;

  for (const m of messages) {
    const content = m.content || '';
    const tokens = estimateTokens(content) + (m.thinking ? estimateTokens(m.thinking) : 0);
    if (m.role === 'system') {
      system += tokens;
    } else if (m.role === 'tool') {
      toolResults += tokens;
    } else {
      // Check for file context embedded in user messages
      const hasFileContext = /<file_context>|User's selected code from|already provided — do not re-read/.test(content);
      if (m.role === 'user' && hasFileContext) {
        files += tokens;
      } else {
        msgs += tokens;
      }
    }
  }

  // Rough estimate for tool definitions (~30 tokens per tool on average)
  const toolDefs = (toolDefinitionCount || 0) * 30;

  const estimatedTotal = system + toolDefs + msgs + toolResults + files;

  // If we have real token counts, scale categories proportionally
  if (actualPromptTokens && estimatedTotal > 0) {
    const scale = actualPromptTokens / estimatedTotal;
    return {
      system: Math.round(system * scale),
      toolDefinitions: Math.round(toolDefs * scale),
      messages: Math.round(msgs * scale),
      toolResults: Math.round(toolResults * scale),
      files: Math.round(files * scale),
      total: actualPromptTokens
    };
  }

  return {
    system,
    toolDefinitions: toolDefs,
    messages: msgs,
    toolResults,
    files,
    total: estimatedTotal
  };
}

/** Result of a compaction attempt. `false` if skipped, or details if performed. */
export interface CompactionResult {
  /** Number of messages that were summarized into a single message. */
  summarizedMessages: number;
  /** Estimated tokens before compaction. */
  tokensBefore: number;
  /** Estimated tokens after compaction. */
  tokensAfter: number;
}

export class AgentContextCompactor {
  constructor(
    private readonly client: OllamaClient
  ) {}

  /**
   * Check if conversation history needs compaction and perform it if so.
   *
   * @param messages - The full messages array (mutated in place)
   * @param contextWindow - The model's context window size in tokens
   * @param model - Model name for the summarization call
   * @param actualPromptTokens - Real prompt token count from Ollama metrics (when available).
   *                             Takes precedence over the heuristic estimate.
   * @returns `false` if no compaction needed, or a CompactionResult with stats
   */
  async compactIfNeeded(
    messages: any[],
    contextWindow: number,
    model: string,
    actualPromptTokens?: number
  ): Promise<CompactionResult | false> {
    const currentTokens = actualPromptTokens ?? estimateMessagesTokens(messages);
    const threshold = Math.floor(contextWindow * 0.70);

    if (currentTokens < threshold) return false;
    if (messages.length <= 4) return false; // system + user + at least 2 exchanges — nothing to compact

    // Preserve: system prompt (index 0), last 3 message pairs (6 messages)
    const preserveCount = Math.min(6, messages.length - 1);
    const preserveStart = messages.length - preserveCount;

    // Messages to summarize: everything between system prompt and preserved tail
    const toSummarize = messages.slice(1, preserveStart);
    if (toSummarize.length < 2) return false; // not enough to summarize

    const summary = await this.generateSummary(toSummarize, messages[0]?.content || '', model);
    if (!summary) return false;

    const summarizedCount = toSummarize.length;

    // Replace summarized messages with compact summary
    const summaryMessage = {
      role: 'user' as const,
      content: `<context_summary>
${summary}
</context_summary>

The above is a summary of our earlier conversation. Continue from where we left off.`
    };

    messages.splice(1, preserveStart - 1, summaryMessage);

    const tokensAfter = estimateMessagesTokens(messages);
    return { summarizedMessages: summarizedCount, tokensBefore: currentTokens, tokensAfter };
  }

  private async generateSummary(
    messagesToSummarize: any[],
    systemPromptContext: string,
    model: string
  ): Promise<string> {
    // Build a readable transcript of the conversation segment
    const transcript = messagesToSummarize.map(m => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User';
      const toolTag = m.tool_name ? ` (${m.tool_name})` : '';
      const content = (m.content || '').slice(0, 1500); // cap individual messages
      return `[${role}${toolTag}]: ${content}`;
    }).join('\n\n');

    const summaryPrompt = `You are summarizing a coding agent conversation to preserve context. The conversation history is getting long and needs compaction. Create a structured continuation summary that enables immediate resumption of the task.

CONVERSATION SEGMENT TO SUMMARIZE:
${transcript}

Create a summary with these sections:

1. TASK OVERVIEW: The user's core request and success criteria. Any clarifications or constraints they specified.
2. CURRENT STATE: What has been completed so far. List specific files created, modified, or analyzed with paths. Key outputs or artifacts produced.
3. IMPORTANT DISCOVERIES: Technical constraints or requirements uncovered. Decisions made and their rationale. Errors encountered and how they were resolved.
4. APPROACHES THAT FAILED: What was tried and didn't work, and why. Include error messages. This prevents repeating failed approaches.
5. PROMISES MADE: Any commitments to the user that must not be forgotten after compaction (e.g., "I'll also update the tests").
6. NEXT STEPS: Specific actions needed to complete the task. Any blockers or open questions. Priority order if multiple steps remain.
7. KEY CODE CONTEXT: Important file paths, function names, variable names, or patterns needed for reference.
8. USER INTENT (VERBATIM): Quote the user's most recent instructions word-for-word. This prevents intent drift after compaction. If the user corrected you or gave specific feedback, include those quotes too.

Be concise but complete — include file paths, function names, error messages, and exact details. This summary replaces the original messages, so nothing can be looked up later. Err on the side of including information that prevents duplicate work or repeated mistakes.`;

    try {
      const stream = this.client.chat({
        model,
        messages: [
          { role: 'system', content: 'You are a conversation summarizer. Be thorough and specific.' },
          { role: 'user', content: summaryPrompt }
        ]
      });

      let result = '';
      for await (const chunk of stream) {
        if (chunk.message?.content) {
          result += chunk.message.content;
        }
      }
      return result.trim();
    } catch {
      return '';
    }
  }
}
