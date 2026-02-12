import { scrollToBottom } from '../actions/index';
import { activeThinkingGroup, currentProgressIndex, currentSessionId } from '../state';
import type { CommandApprovalItem, FileEditApprovalItem, ProgressItem, ToolApprovalResultMessage } from '../types';
import { ensureAssistantThread, getOrCreateToolsBlock } from './threadUtils';

/**
 * Find the current progress group, checking both the thinking group's tools
 * sections and the thread-level tools block.
 */
const findCurrentProgressGroup = (): ProgressItem | null => {
  if (currentProgressIndex.value === null) return null;

  // First check inside the active thinking group
  if (activeThinkingGroup.value) {
    for (const section of activeThinkingGroup.value.sections) {
      if (section.type === 'tools') {
        const item = section.tools[currentProgressIndex.value];
        if (item && item.type === 'progress') return item as ProgressItem;
      }
    }
  }

  // Fall back to thread-level tools block
  const thread = ensureAssistantThread();
  const toolsBlock = getOrCreateToolsBlock(thread);
  const item = toolsBlock.tools[currentProgressIndex.value];
  if (item && item.type === 'progress') return item as ProgressItem;

  return null;
};

/**
 * Search all tools blocks (both in thinking groups and thread-level) for an
 * approval card by id and type.
 */
const findApprovalCard = <T extends CommandApprovalItem | FileEditApprovalItem>(
  type: 'commandApproval' | 'fileEditApproval',
  approvalId: string
): T | undefined => {
  const thread = ensureAssistantThread();
  for (const block of thread.blocks) {
    if (block.type === 'tools') {
      const found = block.tools.find(item => item.type === type && item.id === approvalId);
      if (found) return found as T;
    }
    if (block.type === 'thinkingGroup') {
      for (const section of block.sections) {
        if (section.type === 'tools') {
          const found = section.tools.find(item => item.type === type && item.id === approvalId);
          if (found) return found as T;
        }
      }
    }
  }
  return undefined;
};

export const handleRequestToolApproval = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (msg.approval) {
    const thread = ensureAssistantThread();
    // Always place approval cards at thread level (outside thinking group)
    const toolsBlock = getOrCreateToolsBlock(thread);

    // Add action to current progress group (which may be inside the thinking group)
    const group = findCurrentProgressGroup();
    if (group) {
      group.actions.push({
        id: `action_${msg.approval.id}`,
        status: 'running',
        icon: '⚡',
        text: 'Run command',
        detail: 'Awaiting approval'
      });
    }

    // Add the approval card
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
    toolsBlock.tools.push(item);
    scrollToBottom();
  }
};

export const handleToolApprovalResult = (msg: ToolApprovalResultMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }

  // Update action in progress group (which may be inside a thinking group)
  const group = findCurrentProgressGroup();
  if (group) {
    const actionId = `action_${msg.approvalId}`;
    const existingAction = group.actions.find(a => a.id === actionId);
    if (existingAction) {
      if (msg.status === 'running') {
        existingAction.status = 'running';
      } else {
        const isError = msg.status === 'skipped' || msg.status === 'error';
        existingAction.status = isError ? 'error' : 'success';
        existingAction.detail = msg.command?.substring(0, 60) || existingAction.detail;
        if (isError) group.status = 'error';
      }
    }
  }

  // Update the approval card (search all tools blocks including thinking groups)
  const existing = findApprovalCard<CommandApprovalItem>('commandApproval', msg.approvalId || '');
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
    // Fallback: add new approval card at thread level
    const thread = ensureAssistantThread();
    const toolsBlock = getOrCreateToolsBlock(thread);
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
    toolsBlock.tools.push(item);
  }
  scrollToBottom();
};

export const handleRequestFileEditApproval = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (msg.approval) {
    const item: FileEditApprovalItem = {
      id: msg.approval.id,
      type: 'fileEditApproval',
      filePath: msg.approval.filePath,
      severity: msg.approval.severity || 'medium',
      reason: msg.approval.reason,
      status: 'pending',
      timestamp: msg.approval.timestamp || Date.now(),
      diffHtml: msg.approval.diffHtml,
      autoApproved: false
    };
    const thread = ensureAssistantThread();
    const toolsBlock = getOrCreateToolsBlock(thread);
    toolsBlock.tools.push(item);
    scrollToBottom();
  }
};

export const handleFileEditApprovalResult = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  // Search all tools blocks including thinking groups
  const existing = findApprovalCard<FileEditApprovalItem>('fileEditApproval', msg.approvalId || '');
  if (existing) {
    existing.status = msg.status || existing.status;
    existing.autoApproved = !!msg.autoApproved || existing.autoApproved;
    if (typeof msg.diffHtml === 'string') {
      existing.diffHtml = msg.diffHtml;
    }
    if (typeof msg.filePath === 'string') {
      existing.filePath = msg.filePath;
    }
    if (msg.reason) {
      existing.reason = msg.reason;
    }
  } else {
    // Fallback: add new approval card at thread level
    const thread = ensureAssistantThread();
    const toolsBlock = getOrCreateToolsBlock(thread);
    const item: FileEditApprovalItem = {
      id: msg.approvalId || `approval_${Date.now()}`,
      type: 'fileEditApproval',
      filePath: msg.filePath || 'file',
      severity: msg.severity || 'medium',
      reason: msg.reason,
      status: msg.status || 'approved',
      timestamp: Date.now(),
      diffHtml: msg.diffHtml,
      autoApproved: !!msg.autoApproved
    };
    toolsBlock.tools.push(item);
  }
  // NOTE: Do NOT complete progress group here. The showToolAction(success) and finishProgressGroup
  // events are responsible for that. We only update the approval card status.
  scrollToBottom();
};
