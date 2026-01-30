import * as vscode from 'vscode';

export type SessionStatus = 'planned' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';

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
