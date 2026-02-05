import { currentAssistantThreadId, currentProgressIndex, currentStreamIndex, timeline } from '../state';
import type { ProgressItem } from '../types';
import { scrollToBottom } from './scroll';

export const ensureProgressGroup = (title = 'Working on task') => {
  if (currentProgressIndex.value !== null) return;
  const group: ProgressItem = {
    id: `progress_${Date.now()}`,
    type: 'progress',
    title,
    status: 'running',
    collapsed: false,
    actions: [],
    lastActionStatus: undefined
  };
  timeline.value.push(group);
  currentProgressIndex.value = timeline.value.length - 1;
  scrollToBottom();
};

export const startAssistantMessage = (model?: string) => {
  const message = {
    id: `msg_${Date.now()}`,
    type: 'assistantThread' as const,
    role: 'assistant' as const,
    model,
    blocks: [
      {
        type: 'text' as const,
        content: ''
      }
    ]
  };
  timeline.value.push(message);
  currentStreamIndex.value = timeline.value.length - 1;
  currentAssistantThreadId.value = message.id;
  scrollToBottom();
};
