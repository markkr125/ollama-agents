import { selectModel, startAssistantMessage } from '../actions/index';
import { currentModel, currentStreamIndex, modelOptions, settings, timeline } from '../state';
import type { AssistantThreadItem } from '../types';

export const getActiveAssistantThread = (): AssistantThreadItem | null => {
  if (currentStreamIndex.value !== null) {
    const item = timeline.value[currentStreamIndex.value];
    if (item && item.type === 'assistantThread') {
      return item as AssistantThreadItem;
    }
  }
  for (let i = timeline.value.length - 1; i >= 0; i--) {
    const item = timeline.value[i];
    if (item.type === 'assistantThread') {
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

export const syncModelSelection = () => {
  if (modelOptions.value.length === 0) return;
  const preferred = currentModel.value || settings.agentModel || modelOptions.value[0];
  const nextModel = modelOptions.value.includes(preferred) ? preferred : modelOptions.value[0];
  if (nextModel !== currentModel.value) {
    currentModel.value = nextModel;
  }
  selectModel();
};
