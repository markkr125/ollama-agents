import type * as vscode from 'vscode';
import type { TerminalManager } from '../services/terminalManager';

// ---------------------------------------------------------------------------
// Shared agent type definitions — used by toolRegistry, executor, and
// agent sub-handlers. Centralised here to avoid circular dependencies.
// ---------------------------------------------------------------------------

/**
 * Configuration for agent execution loops (both legacy and modern executors).
 */
export interface ExecutorConfig {
  maxIterations: number;
  toolTimeout: number;
  temperature: number;
}

/**
 * Definition of a single agent tool. Each tool has a name, schema (for LLM
 * function calling), and an execute function.
 */
export interface Tool {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  execute: (params: any, context: ToolContext) => Promise<string>;
}

/**
 * Runtime context passed to every tool's `execute()` method.
 */
export interface ToolContext {
  /** Primary workspace folder (first folder, or the folder the session was started in). */
  workspace: vscode.WorkspaceFolder;
  /** All workspace folders — for multi-root workspace support. */
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
  token: vscode.CancellationToken;
  outputChannel: vscode.OutputChannel;
  sessionId?: string;
  terminalManager?: TerminalManager;
  /**
   * Optional callback for running a sub-agent with read-only tools.
   * Injected by the agent executor; used by `run_subagent` tool.
   */
  runSubagent?: (task: string, mode: 'explore' | 'review' | 'deep-explore') => Promise<string>;
}

/**
 * Callback type for persisting UI events to the database.
 * Defined here (rather than in a handler file) to avoid circular
 * dependencies between agent sub-handlers and the executor.
 */
export type PersistUiEventFn = (
  sessionId: string | undefined,
  eventType: string,
  payload: Record<string, any>
) => Promise<void>;

// ---------------------------------------------------------------------------
// Agent Control Plane — structured continuation messages
// ---------------------------------------------------------------------------

/**
 * State of the agent loop communicated via `<agent_control>` packets.
 * Replaces the old free-text continuation messages with a machine-readable
 * format that models can parse unambiguously.
 */
export type AgentControlState = 'need_tools' | 'need_fixes' | 'need_summary' | 'complete';

/**
 * Structured control packet embedded in continuation messages.
 * Contains iteration budget, task context, and loop state so the model
 * knows exactly what's expected without redundant natural-language prompts.
 */
export interface AgentControlPacket {
  state: AgentControlState;
  iteration: number;
  maxIterations: number;
  remainingIterations: number;
  task?: string;
  filesChanged?: string[];
  toolResults?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Agent Dispatcher — intent classification for routing + prompt framing
// ---------------------------------------------------------------------------

/**
 * Classified intent of the user's task.
 *   analyze — understand/explore/trace/document code (read is the goal)
 *   modify  — edit/fix/refactor existing code (write existing files)
 *   create  — build new features/files from scratch
 *   mixed   — combination of the above
 */
export type TaskIntent = 'analyze' | 'modify' | 'create' | 'mixed';

/**
 * Result of intent classification. Determines executor routing and prompt adaptation.
 * The intent is passed to AgentPromptBuilder which adapts its existing doingTasks()
 * section accordingly — no separate framing text is generated.
 */
export interface DispatchResult {
  /** Classified primary intent. */
  intent: TaskIntent;
  /** Whether the task requires writing files (docs, output, etc.). */
  needsWrite: boolean;
  /** Confidence score 0-1. 0 = LLM classification failed (defaulted to mixed). */
  confidence: number;
  /** Short reasoning for diagnostic logging. */
  reasoning: string;
}
