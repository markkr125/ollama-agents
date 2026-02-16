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
   * @returns Whether compaction was performed
   */
  async compactIfNeeded(
    messages: any[],
    contextWindow: number,
    model: string
  ): Promise<boolean> {
    const currentTokens = estimateMessagesTokens(messages);
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

    // Replace summarized messages with compact summary
    const summaryMessage = {
      role: 'user' as const,
      content: `<context_summary>
${summary}
</context_summary>

The above is a summary of our earlier conversation. Continue from where we left off.`
    };

    messages.splice(1, preserveStart - 1, summaryMessage);
    return true;
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

    const summaryPrompt = `You are summarizing a coding agent conversation to preserve context. The agent has been working on a task and the conversation history is getting long. Create a structured summary that captures everything needed to continue the work.

CONVERSATION SEGMENT TO SUMMARIZE:
${transcript}

Create a summary with these sections:

<analysis>
1. TASK OVERVIEW: What the user originally asked for and what success looks like.
2. CURRENT STATE: What has been completed so far. List specific files modified, functions changed, and their current status.
3. IMPORTANT DISCOVERIES: Constraints found, architectural decisions made, errors encountered and how they were resolved.
4. APPROACHES THAT FAILED: What was tried and didn't work, and why. Include error messages. This prevents the agent from repeating failed approaches.
5. PROMISES MADE: Any commitments to the user (e.g. "I'll also update the tests", "I'll clean up the scratch files"). These must not be forgotten after compaction.
6. NEXT STEPS: What still needs to be done, any blockers, priority order.
7. KEY CODE CONTEXT: Important file paths, function names, variable names, or patterns that the agent will need to reference.
</analysis>

Be specific — include file paths, function names, error messages, and exact details. This summary replaces the original messages, so nothing can be looked up later.`;

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
