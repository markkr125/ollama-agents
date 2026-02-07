import type { ActionItem, ProgressItem, TimelineItem } from '../types';

// --- Types used only by ChatPage ---

export type ThinkingState = {
  visible: boolean;
  text: string;
};

export type ContextItem = {
  fileName: string;
  content: string;
};

// --- Props interface for ChatPage component ---

export interface ChatPageProps {
  currentPage: 'chat' | 'settings' | 'sessions';
  setMessagesEl: (value: HTMLDivElement | null) => void;
  setInputEl: (value: HTMLTextAreaElement | null) => void;
  timeline: TimelineItem[];
  thinking: ThinkingState;
  contextList: ContextItem[];
  inputText: string;
  setInputText: (value: string) => void;
  currentMode: string;
  setCurrentMode: (value: string) => void;
  currentModel: string;
  setCurrentModel: (value: string) => void;
  modelOptions: string[];
  autoApproveCommands: boolean;
  autoApproveConfirmVisible: boolean;
  toggleAutoApproveCommands: () => void;
  confirmAutoApproveCommands: () => void;
  cancelAutoApproveCommands: () => void;
  approveCommand: (approvalId: string, command: string) => void;
  skipCommand: (approvalId: string) => void;
  approveFileEdit: (approvalId: string) => void;
  skipFileEdit: (approvalId: string) => void;
  openFileDiff: (approvalId: string) => void;
  autoApproveSensitiveEdits: boolean;
  toggleAutoApproveSensitiveEdits: () => void;
  autoApproveSensitiveEditsConfirmVisible: boolean;
  confirmAutoApproveSensitiveEdits: () => void;
  cancelAutoApproveSensitiveEdits: () => void;
  isGenerating: boolean;
  toggleProgress: (item: ProgressItem) => void;
  actionStatusClass: (status: ActionItem['status']) => Record<string, boolean>;
  addContext: () => void;
  removeContext: (index: number) => void;
  handleEnter: () => void;
  handleSend: () => void;
  resizeInput: () => void;
  selectMode: () => void;
  selectModel: () => void;
  scrollTargetMessageId: string | null;
  clearScrollTarget: () => void;
}
