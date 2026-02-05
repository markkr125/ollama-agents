import { scrollToBottom } from '../actions/index';
import { currentProgressIndex, currentSessionId } from '../state';
import type { ActionItem, ProgressItem, ShowToolActionMessage, StartProgressGroupMessage } from '../types';
import { ensureAssistantThread, getOrCreateToolsBlock } from './threadUtils';

export const handleStartProgressGroup = (msg: StartProgressGroupMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  const thread = ensureAssistantThread();
  const toolsBlock = getOrCreateToolsBlock(thread);
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
  const thread = ensureAssistantThread();
  const toolsBlock = getOrCreateToolsBlock(thread);
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
  const action = {
    id: `action_${Date.now()}_${Math.random()}`,
    status: msg.status || 'running',
    icon: msg.icon || '•',
    text: actionText,
    detail: msg.detail || null
  };
  if (action.status !== 'running' && action.status !== 'pending') {
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
  } else {
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
  const thread = ensureAssistantThread();
  const toolsBlock = getOrCreateToolsBlock(thread);
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
  const thread = ensureAssistantThread();
  const toolsBlock = getOrCreateToolsBlock(thread);
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
