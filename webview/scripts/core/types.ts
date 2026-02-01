export type MessageItem = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  model?: string;
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

export type TimelineItem = MessageItem | ProgressItem;

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
