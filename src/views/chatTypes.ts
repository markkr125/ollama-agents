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
