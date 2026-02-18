import * as vscode from 'vscode';
import { type DispatchResult, type TaskIntent } from '../../types/agent';
import { OllamaClient } from '../model/ollamaClient';

// ---------------------------------------------------------------------------
// AgentDispatcher — classifies user intent BEFORE the agent loop starts.
//
// Uses LLM classification (no timeout — waits for the model to respond).
// On failure, defaults to 'mixed' intent so the full agent executor handles
// the task. The caller shows a spinner while this runs.
//
// The result controls:
//   1. Executor routing (explore vs agent)
//   2. Prompt selection (analysis prompt vs coding agent prompt)
//   3. Tool availability (read-only for pure analysis)
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM = `You are a task classifier. Given a user's request to a coding agent, classify the PRIMARY intent.

Respond with ONLY a JSON object, nothing else:
{"intent":"analyze|modify|create|mixed","needsWrite":true|false,"reasoning":"one sentence"}

Rules:
- "analyze" = user wants to UNDERSTAND, EXPLORE, TRACE, EXPLAIN, or DOCUMENT code. Reading/tracing code is the goal even if a docs file is created.
- "modify" = user wants to CHANGE, FIX, REFACTOR, or UPDATE existing source code files.
- "create" = user wants to BUILD new features, create new source code files, add new functionality.
- "mixed" = user wants multiple of the above (e.g., "understand auth and then fix the bug").
- "needsWrite" = true if the task requires creating or writing any file (docs, source, config, output).
- "go into every function" means TRACE/ANALYZE (intent=analyze), NOT refactor.
- "create documentation" means needsWrite=true (a docs file is created), still intent=analyze.
- "as nested as possible" in analysis context means trace calls to maximum depth, NOT restructure code.`;

export class AgentDispatcher {
  constructor(
    private readonly client: OllamaClient,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  /**
   * Classify user intent via LLM. Falls back to 'mixed' on failure.
   */
  async classify(userMessage: string, model: string): Promise<DispatchResult> {
    try {
      const result = await this.llmClassify(userMessage, model);
      if (result) {
        this.outputChannel.appendLine(
          `[Dispatcher] LLM: intent=${result.intent}, needsWrite=${result.needsWrite}, confidence=${result.confidence} — ${result.reasoning}`
        );
        return result;
      }
    } catch (err) {
      this.outputChannel.appendLine(`[Dispatcher] LLM classification failed: ${err}`);
    }

    this.outputChannel.appendLine('[Dispatcher] LLM classification failed — defaulting to mixed');
    return {
      intent: 'mixed',
      needsWrite: true,
      confidence: 0,
      reasoning: 'LLM classification failed — defaulting to mixed',
    };
  }

  // -------------------------------------------------------------------------
  // LLM classification (no timeout — waits for the model to respond)
  // -------------------------------------------------------------------------

  private async llmClassify(message: string, model: string): Promise<DispatchResult | null> {
    const truncated = message.length > 500
      ? message.substring(0, 500) + '...'
      : message;

    const request = {
      model,
      messages: [
        { role: 'system' as const, content: CLASSIFY_SYSTEM },
        { role: 'user' as const, content: truncated }
      ],
      options: { temperature: 0, num_predict: 150 },
      keep_alive: '30m',
      stream: false as const
    };

    const result = await this.client.chatNoStream(request);

    // Parse JSON from response
    const text = (result as any).message?.content || '';
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      this.outputChannel.appendLine(`[Dispatcher] LLM returned non-JSON: ${text.substring(0, 200)}`);
      return null;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const intent: TaskIntent = ['analyze', 'modify', 'create', 'mixed'].includes(parsed.intent)
        ? parsed.intent
        : 'mixed';
      const needsWrite = !!parsed.needsWrite;
      const reasoning = parsed.reasoning || 'LLM classified';

      return {
        intent,
        needsWrite,
        confidence: 0.85,
        reasoning,
      };
    } catch {
      this.outputChannel.appendLine(`[Dispatcher] Failed to parse LLM JSON: ${jsonMatch[0]}`);
      return null;
    }
  }
}
