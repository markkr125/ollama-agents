export type ModelCapabilities = {
  chat: boolean;
  fim: boolean;
  tools: boolean;
  vision: boolean;
  embedding: boolean;
};

export type ModelInfo = {
  name: string;
  size: number;
  parameterSize?: string;
  quantizationLevel?: string;
  capabilities: ModelCapabilities;
  enabled: boolean;
  contextLength?: number;
  maxContext?: number | null;
};

export type ContextFileRef = {
  fileName: string;
  kind?: 'explicit' | 'implicit-file' | 'implicit-selection';
  lineRange?: string;
};

export type MessageItem = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  contextFiles?: ContextFileRef[];
};

export type AssistantThreadTextBlock = {
  type: 'text';
  content: string;
};

export type AssistantThreadThinkingBlock = {
  type: 'thinking';
  content: string;
  collapsed: boolean;
  startTime?: number;
  durationSeconds?: number;
};

export type AssistantThreadToolsBlock = {
  type: 'tools';
  tools: Array<ProgressItem | CommandApprovalItem | FileEditApprovalItem>;
};

/**
 * A section inside a ThinkingGroupBlock. Contains only thinking content
 * and tool progress — text content is always at thread level.
 */
export type ThinkingGroupSection =
  | { type: 'thinkingContent'; content: string; durationSeconds?: number; startTime?: number }
  | AssistantThreadToolsBlock;

/**
 * Groups consecutive thinking rounds and tool progress groups into a single
 * collapsible block. Only created for thinking models.
 * Text content is never placed inside — it streams directly to thread-level blocks.
 * Approval cards intentionally break out to thread-level blocks.
 */
export type AssistantThreadThinkingGroupBlock = {
  type: 'thinkingGroup';
  sections: ThinkingGroupSection[];
  collapsed: boolean;
  streaming: boolean;
  totalDurationSeconds?: number;
};

export type FileChangeFileItem = {
  path: string;
  action: string;
  additions?: number;
  deletions?: number;
  status: 'pending' | 'kept' | 'undone';
  checkpointId: string;
};

export type AssistantThreadFilesChangedBlock = {
  type: 'filesChanged';
  checkpointIds: string[];
  files: FileChangeFileItem[];
  totalAdditions?: number;
  totalDeletions?: number;
  status: 'pending' | 'kept' | 'undone' | 'partial';
  collapsed: boolean;
  statsLoading: boolean;
  currentChange?: number;
  totalChanges?: number;
  activeFilePath?: string;
};

export type AssistantThreadItem = {
  id: string;
  type: 'assistantThread';
  role: 'assistant';
  blocks: Array<AssistantThreadTextBlock | AssistantThreadThinkingBlock | AssistantThreadToolsBlock | AssistantThreadThinkingGroupBlock>;
  model?: string;
};

export type ActionItem = {
  id: string;
  status: 'running' | 'success' | 'error' | 'pending';
  icon: string;
  text: string;
  detail?: string | null;
  filePath?: string;
  checkpointId?: string;
  startLine?: number;
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
  status: 'pending' | 'running' | 'approved' | 'skipped';
  timestamp: number;
  output?: string;
  exitCode?: number | null;
  autoApproved?: boolean;
};

export type FileEditApprovalItem = {
  id: string;
  type: 'fileEditApproval';
  filePath: string;
  severity: 'critical' | 'high' | 'medium';
  reason?: string;
  status: 'pending' | 'approved' | 'skipped';
  timestamp: number;
  diffHtml?: string;
  autoApproved?: boolean;
};

export type TimelineItem = MessageItem | AssistantThreadItem | ProgressItem | CommandApprovalItem | FileEditApprovalItem;

export type SessionItem = {
  id: string;
  title: string;
  timestamp: number;
  active: boolean;
  status: 'idle' | 'generating' | 'completed' | 'error';
  pendingAdditions?: number;
  pendingDeletions?: number;
  pendingFileCount?: number;
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
  autoApproveSensitiveEdits?: boolean;
  sessionSensitiveFilePatterns?: string | null;
};

export type StreamChunkMessage = {
  type: 'streamChunk' | 'finalMessage';
  sessionId?: string;
  content?: string;
  model?: string;
};

export type TokenUsageMessage = {
  type: 'tokenUsage';
  sessionId?: string;
  promptTokens?: number;
  completionTokens?: number;
  contextWindow?: number;
  categories?: {
    system: number;
    toolDefinitions: number;
    messages: number;
    toolResults: number;
    files: number;
    total: number;
  };
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
  filePath?: string;
  checkpointId?: string;
  startLine?: number;
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

export type FileEditApprovalRequestMessage = {
  type: 'requestFileEditApproval';
  sessionId?: string;
  approval?: {
    id: string;
    filePath: string;
    severity?: FileEditApprovalItem['severity'];
    reason?: string;
    status?: FileEditApprovalItem['status'];
    timestamp?: number;
    diffHtml?: string;
  };
};

export type FileEditApprovalResultMessage = {
  type: 'fileEditApprovalResult';
  approvalId?: string;
  sessionId?: string;
  status?: FileEditApprovalItem['status'];
  autoApproved?: boolean;
  filePath?: string;
  severity?: FileEditApprovalItem['severity'];
  reason?: string;
  diffHtml?: string;
};

export type StreamThinkingMessage = {
  type: 'streamThinking';
  sessionId?: string;
  content?: string;
};

export type CollapseThinkingMessage = {
  type: 'collapseThinking';
  sessionId?: string;
  durationSeconds?: number;
};

export type ShowWarningBannerMessage = {
  type: 'showWarningBanner';
  sessionId?: string;
  message?: string;
};
