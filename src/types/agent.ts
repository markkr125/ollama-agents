import type * as vscode from 'vscode';
import type { ModelCapabilities } from '../services/model/modelCompatibility';
import type { TerminalManager } from '../services/terminalManager';
import type { MessageRecord, Session } from './session';

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
  /** Resolved explorer model for sub-agents (3-tier fallback: session → global → agent model). Empty string = use same model as orchestrator. */
  explorerModel?: string;
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
   * @param task - Detailed task description for the sub-agent
   * @param mode - Execution mode (explore/review/deep-explore)
   * @param contextHint - Optional hint to focus the sub-agent's exploration
   * @param title - Optional short label for UI display
   * @param description - Optional one-sentence description shown alongside the title
   */
  runSubagent?: (task: string, mode: 'explore' | 'review' | 'deep-explore', contextHint?: string, title?: string, description?: string) => Promise<string>;
}

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

// ---------------------------------------------------------------------------
// Agent Execute Params — parameter object for AgentChatExecutor.execute()
// ---------------------------------------------------------------------------

/**
 * Parameter object for AgentChatExecutor.execute() — replaces 8 positional params.
 */
export interface AgentExecuteParams {
  agentSession: Session;
  config: ExecutorConfig;
  token: vscode.CancellationToken;
  sessionId: string;
  model: string;
  capabilities?: ModelCapabilities;
  conversationHistory?: MessageRecord[];
  dispatch?: DispatchResult;
}
