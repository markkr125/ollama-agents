import { scrollToBottom } from '../actions/index';
import { activeThinkingGroup, currentProgressIndex, currentSessionId } from '../state';
import type { ActionItem, AssistantThreadToolsBlock, ProgressItem, ShowToolActionMessage, StartProgressGroupMessage } from '../types';
import { ensureAssistantThread, getOrCreateToolsBlock } from './threadUtils';

/**
 * Get or create a tools block inside the active thinking group's sections.
 * Reuses the last section if it's already a tools block.
 */
const getOrCreateToolsBlockInGroup = (): AssistantThreadToolsBlock => {
  const group = activeThinkingGroup.value!;
  const lastSection = group.sections[group.sections.length - 1];
  if (lastSection && lastSection.type === 'tools') {
    return lastSection;
  }
  const block: AssistantThreadToolsBlock = { type: 'tools', tools: [] };
  group.sections.push(block);
  return block;
};

/**
 * Resolve the correct tools block: inside the thinking group if active,
 * otherwise at thread level.
 */
const resolveToolsBlock = (): AssistantThreadToolsBlock => {
  if (activeThinkingGroup.value) {
    return getOrCreateToolsBlockInGroup();
  }
  const thread = ensureAssistantThread();
  return getOrCreateToolsBlock(thread);
};

export const handleStartProgressGroup = (msg: StartProgressGroupMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();
  const toolsBlock = resolveToolsBlock();
  const group: ProgressItem = {
    id: `progress_${Date.now()}`,
    type: 'progress',
    title: msg.title || 'Working on task',
    status: 'running',
    collapsed: false,
    actions: [],
    lastActionStatus: undefined
  };
  toolsBlock.tools.push(group);
  currentProgressIndex.value = toolsBlock.tools.length - 1;
};

export const handleShowToolAction = (msg: ShowToolActionMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();
  const toolsBlock = resolveToolsBlock();

  // Find last progress group in current tools block (more reliable than global index)
  let group: ProgressItem | null = null;
  for (let i = toolsBlock.tools.length - 1; i >= 0; i--) {
    if (toolsBlock.tools[i].type === 'progress') {
      group = toolsBlock.tools[i] as ProgressItem;
      currentProgressIndex.value = i;
      break;
    }
  }

  if (!group) {
    group = {
      id: `progress_${Date.now()}`,
      type: 'progress',
      title: 'Working on task',
      status: 'running',
      collapsed: false,
      actions: [],
      lastActionStatus: undefined
    };
    toolsBlock.tools.push(group);
    currentProgressIndex.value = toolsBlock.tools.length - 1;
  }

  const actionText = msg.text || '';
  const existingIndex = group.actions.findIndex(actionItem =>
    (actionItem.status === 'running' || actionItem.status === 'pending') &&
    actionItem.text === actionText
  );
  const lastRunningIndex = existingIndex >= 0
    ? existingIndex
    : [...group.actions].reverse().findIndex(actionItem => actionItem.status === 'running' || actionItem.status === 'pending');
  const resolvedIndex = lastRunningIndex >= 0
    ? group.actions.length - 1 - lastRunningIndex
    : -1;
  const action: ActionItem = {
    id: `action_${Date.now()}_${Math.random()}`,
    status: msg.status || 'running',
    icon: msg.icon || '•',
    text: actionText,
    detail: msg.detail || null,
    ...(msg.filePath ? { filePath: msg.filePath } : {}),
    ...(msg.checkpointId ? { checkpointId: msg.checkpointId } : {}),
    ...(msg.startLine != null ? { startLine: msg.startLine } : {})
  };
  if (action.status !== 'running' && action.status !== 'pending') {
    // Final state (success/error) - update existing or push
    if (existingIndex >= 0) {
      group.actions[existingIndex] = { ...group.actions[existingIndex], ...action };
    } else if (resolvedIndex >= 0) {
      group.actions[resolvedIndex] = { ...group.actions[resolvedIndex], ...action };
    } else {
      group.actions.push(action);
    }
    const hasActive = group.actions.some(
      actionItem => actionItem.status === 'running' || actionItem.status === 'pending'
    );
    if (!hasActive) {
      group.status = action.status === 'error' ? 'error' : 'done';
    }
  } else if (existingIndex >= 0) {
    // Running/pending with same text as existing - update in place
    group.actions[existingIndex] = { ...group.actions[existingIndex], ...action };
    group.status = 'running';
  } else {
    // New running/pending action - push
    group.actions.push(action);
    group.status = 'running';
  }
  group.lastActionStatus = action.status;
  scrollToBottom();
};

export const handleFinishProgressGroup = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();
  const toolsBlock = resolveToolsBlock();
  if (currentProgressIndex.value !== null) {
    const group = toolsBlock.tools[currentProgressIndex.value] as ProgressItem;
    const hasError = group.actions.some(action => action.status === 'error');
    group.status = hasError ? 'error' : 'done';
    group.collapsed = true;
    group.actions = group.actions.map(action =>
      action.status === 'running' || action.status === 'pending'
        ? { ...action, status: 'success' }
        : action
    );
    const lastAction = group.actions[group.actions.length - 1];
    group.lastActionStatus = lastAction?.status || 'success';
  }
  currentProgressIndex.value = null;
};

export const handleShowError = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();
  const toolsBlock = resolveToolsBlock();
  if (currentProgressIndex.value === null) {
    const group: ProgressItem = {
      id: `progress_${Date.now()}`,
      type: 'progress',
      title: 'Working on task',
      status: 'running',
      collapsed: false,
      actions: [],
      lastActionStatus: undefined
    };
    toolsBlock.tools.push(group);
    currentProgressIndex.value = toolsBlock.tools.length - 1;
  }
  const group = toolsBlock.tools[currentProgressIndex.value] as ProgressItem;
  const action: ActionItem = {
    id: `action_${Date.now()}_${Math.random()}`,
    status: 'error',
    icon: '✗',
    text: msg.message || 'Error',
    detail: null
  };
  group.actions.push(action);
  group.lastActionStatus = action.status;
  group.status = 'error';
  group.collapsed = true;
  currentProgressIndex.value = null;
};
