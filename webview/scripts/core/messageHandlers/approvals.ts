import { scrollToBottom } from '../actions/index';
import { currentProgressIndex, currentSessionId } from '../state';
import type { CommandApprovalItem, ProgressItem, ToolApprovalResultMessage } from '../types';
import { ensureAssistantThread } from './threadUtils';

export const handleRequestToolApproval = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (msg.approval) {
    const item: CommandApprovalItem = {
      id: msg.approval.id,
      type: 'commandApproval',
      command: msg.approval.command,
      cwd: msg.approval.cwd,
      severity: msg.approval.severity || 'medium',
      reason: msg.approval.reason,
      status: 'pending',
      timestamp: msg.approval.timestamp || Date.now(),
      output: undefined,
      exitCode: null,
      autoApproved: false
    };
    const thread = ensureAssistantThread();
    thread.tools.push(item);
    scrollToBottom();
  }
};

export const handleToolApprovalResult = (msg: ToolApprovalResultMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  const thread = ensureAssistantThread();
  const existing = thread.tools.find(item => item.type === 'commandApproval' && item.id === msg.approvalId) as CommandApprovalItem | undefined;
  if (existing) {
    existing.status = msg.status || existing.status;
    existing.output = msg.output ?? existing.output;
    existing.autoApproved = !!msg.autoApproved || existing.autoApproved;
    if (typeof msg.command === 'string' && msg.command.trim()) {
      existing.command = msg.command;
    }
    if (typeof msg.exitCode === 'number') {
      existing.exitCode = msg.exitCode;
    }
  } else {
    const item: CommandApprovalItem = {
      id: msg.approvalId || `approval_${Date.now()}`,
      type: 'commandApproval',
      command: msg.command || '',
      cwd: msg.cwd,
      severity: msg.severity || 'medium',
      reason: msg.reason,
      status: msg.status || 'approved',
      timestamp: Date.now(),
      output: msg.output,
      exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null,
      autoApproved: !!msg.autoApproved
    };
    thread.tools.push(item);
  }
  if (currentProgressIndex.value !== null && msg.status && msg.status !== 'pending') {
    const group = thread.tools[currentProgressIndex.value] as ProgressItem;
    group.status = 'done';
    group.actions = group.actions.map(action =>
      action.status === 'running' || action.status === 'pending'
        ? { ...action, status: msg.status === 'skipped' ? 'error' : 'success' }
        : action
    );
    group.lastActionStatus = group.actions[group.actions.length - 1]?.status || 'success';
    group.collapsed = true;
    currentProgressIndex.value = null;
  }
  scrollToBottom();
};
