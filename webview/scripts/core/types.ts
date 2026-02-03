export type MessageItem = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  model?: string;
};

export type AssistantThreadItem = {
  id: string;
  type: 'assistantThread';
  role: 'assistant';
  contentBefore: string;
  contentAfter: string;
  model?: string;
  tools: Array<ProgressItem | CommandApprovalItem>;
};

export type ActionItem = {
  id: string;
  status: 'running' | 'success' | 'error' | 'pending';
  icon: string;
  text: string;
  detail?: string | null;
};

export type ProgressItem = {
  id: string;
  type: 'progress';
  title: string;
  status: 'running' | 'done' | 'error';
  collapsed: boolean;
  actions: ActionItem[];
  lastActionStatus?: ActionItem['status'];
};

export type CommandApprovalItem = {
  id: string;
  type: 'commandApproval';
  command: string;
  cwd?: string;
  severity: 'critical' | 'high' | 'medium';
  reason?: string;
  status: 'pending' | 'approved' | 'skipped';
  timestamp: number;
  output?: string;
  exitCode?: number | null;
  autoApproved?: boolean;
};

export type TimelineItem = MessageItem | AssistantThreadItem | ProgressItem | CommandApprovalItem;

export type SessionItem = {
  id: string;
  title: string;
  timestamp: number;
  active: boolean;
  status: 'idle' | 'generating' | 'completed' | 'error';
};

export type StatusMessage = {
  visible: boolean;
  success: boolean;
  message: string;
};

export type SearchResultMessage = {
  id: string;
  content: string;
  snippet: string;
  role: string;
};

export type SearchResultGroup = {
  session: {
    id: string;
    title: string;
    timestamp: number;
  };
  messages: SearchResultMessage[];
};

export type InitMessage = {
  type: 'init';
  models?: { name: string }[];
  currentMode?: string;
  settings?: Record<string, any>;
  hasToken?: boolean;
};

export type LoadSessionMessagesMessage = {
  type: 'loadSessionMessages';
  sessionId?: string;
  messages?: any[];
  autoApproveCommands?: boolean;
};

export type StreamChunkMessage = {
  type: 'streamChunk' | 'finalMessage';
  sessionId?: string;
  content?: string;
  model?: string;
};

export type StartProgressGroupMessage = {
  type: 'startProgressGroup';
  sessionId?: string;
  title?: string;
};

export type ShowToolActionMessage = {
  type: 'showToolAction';
  sessionId?: string;
  status?: ActionItem['status'];
  icon?: string;
  text?: string;
  detail?: string | null;
};

export type ToolApprovalResultMessage = {
  type: 'toolApprovalResult';
  approvalId?: string;
  sessionId?: string;
  status?: CommandApprovalItem['status'];
  output?: string;
  autoApproved?: boolean;
  command?: string;
  exitCode?: number;
  cwd?: string;
  severity?: CommandApprovalItem['severity'];
  reason?: string;
};
