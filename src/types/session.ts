import * as vscode from 'vscode';

export type SessionStatus = 'planned' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';

export type ChatSessionStatus = 'idle' | 'generating' | 'completed' | 'error';

export interface ToolExecution {
  tool: string;
  input: Record<string, any>;
  output: string;
  error?: string;
  timestamp: number;
  progressTitle?: string;
}

export interface Session {
  id: string;
  task: string;
  workspace?: vscode.WorkspaceFolder;
  status: SessionStatus;
  startTime: number;
  endTime?: number;
  model: string;
  toolCalls: ToolExecution[];
  errors: string[];
  branch?: string;
  filesChanged: string[];
}

export interface SessionTreeItem extends vscode.TreeItem {
  session?: Session;
  isFolder?: boolean;
}

// ---------------------------------------------------------------------------
// Chat session records (shared across services and views)
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  title: string;
  mode: string;
  model: string;
  status: ChatSessionStatus;
  auto_approve_commands?: boolean;
  auto_approve_sensitive_edits?: boolean;
  sensitive_file_patterns?: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionsPage {
  sessions: SessionRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  model?: string;
  tool_name?: string;
  tool_input?: string;
  tool_output?: string;
  progress_title?: string;
  /** Serialized JSON of native tool_calls array (only on assistant messages). */
  tool_calls?: string;
  timestamp: number;
  vector?: number[] | Float32Array;
}
