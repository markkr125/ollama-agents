import * as vscode from 'vscode';

/**
 * A message handler that processes one or more webview message types.
 * Implementations are registered with MessageRouter for dispatch.
 */
export interface IMessageHandler {
  /** Message types this handler processes. */
  readonly handledTypes: readonly string[];
  /** Handle a webview message. */
  handle(data: any): Promise<void>;
}

/**
 * Shared mutable state for the chat view, accessible by message handlers.
 * Owned by ChatViewProvider, passed by reference to handlers.
 */
export interface ViewState {
  currentMode: string;
  currentModel: string;
  readonly activeSessions: Map<string, vscode.CancellationTokenSource>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  progressTitle?: string;
  actionText?: string;
  actionDetail?: string;
  actionIcon?: string;
  actionStatus?: 'success' | 'error';
  model?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  mode: string;
  model: string;
  timestamp: number;
  autoApproveCommands?: boolean;
}

export interface ContextItem {
  fileName: string;
  content: string;
}

export interface WebviewMessageEmitter {
  postMessage(message: any): void;
}

// ---------------------------------------------------------------------------
// Files Changed types (B→F and F→B messages for the files-changed widget)
// ---------------------------------------------------------------------------

export interface FileChangeInfo {
  path: string;
  action: string; // 'created' | 'modified'
}

export interface FileDiffStats {
  path: string;
  additions: number;
  deletions: number;
  action: string;
}
