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
