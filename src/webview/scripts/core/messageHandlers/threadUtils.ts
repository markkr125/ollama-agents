import { selectModel, startAssistantMessage } from '../actions/index';
import { currentAssistantThreadId, currentModel, currentStreamIndex, modelOptions, settings, timeline } from '../state';
import type { AssistantThreadItem, AssistantThreadTextBlock, AssistantThreadToolsBlock } from '../types';

export const getActiveAssistantThread = (): AssistantThreadItem | null => {
  if (currentAssistantThreadId.value) {
    const byId = timeline.value.find(
      item => item.type === 'assistantThread' && item.id === currentAssistantThreadId.value
    ) as AssistantThreadItem | undefined;
    if (byId) return byId;
  }
  if (currentStreamIndex.value !== null) {
    const item = timeline.value[currentStreamIndex.value];
    if (item && item.type === 'assistantThread') {
      return item as AssistantThreadItem;
    }
  }
  return null;
};

export const ensureAssistantThread = (model?: string): AssistantThreadItem => {
  let thread = getActiveAssistantThread();
  if (!thread) {
    startAssistantMessage(model);
    thread = getActiveAssistantThread();
  }
  return thread as AssistantThreadItem;
};

export const getLastTextBlock = (thread: AssistantThreadItem): AssistantThreadTextBlock => {
  const last = thread.blocks[thread.blocks.length - 1];
  if (!last || last.type !== 'text') {
    const block: AssistantThreadTextBlock = { type: 'text', content: '' };
    thread.blocks.push(block);
    return block;
  }
  return last;
};

export const getOrCreateToolsBlock = (thread: AssistantThreadItem): AssistantThreadToolsBlock => {
  const last = thread.blocks[thread.blocks.length - 1];
  if (last && last.type === 'tools') {
    return last;
  }
  const block: AssistantThreadToolsBlock = { type: 'tools', tools: [] };
  thread.blocks.push(block);
  return block;
};

export const syncModelSelection = () => {
  if (modelOptions.value.length === 0) return;
  const preferred = currentModel.value || settings.agentModel || modelOptions.value[0];
  const nextModel = modelOptions.value.includes(preferred) ? preferred : modelOptions.value[0];
  if (nextModel !== currentModel.value) {
    currentModel.value = nextModel;
  }
  selectModel();
};
