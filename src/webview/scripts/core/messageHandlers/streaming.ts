import { scrollToBottom, startAssistantMessage } from '../actions/index';
import { currentAssistantThreadId, currentSessionId, currentStreamIndex } from '../state';
import type { StreamChunkMessage } from '../types';
import { ensureAssistantThread, getLastTextBlock } from './threadUtils';

export const handleStreamChunk = (msg: StreamChunkMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (currentStreamIndex.value === null) {
    startAssistantMessage(msg.model);
  }
  const thread = ensureAssistantThread(msg.model);
  currentAssistantThreadId.value = thread.id;
  const textBlock = getLastTextBlock(thread);
  textBlock.content = msg.content || '';
  if (msg.model) {
    thread.model = msg.model;
  }
  scrollToBottom();
};

export const handleFinalMessage = (msg: StreamChunkMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (currentStreamIndex.value === null) {
    startAssistantMessage(msg.model);
  }
  const thread = ensureAssistantThread(msg.model);
  currentAssistantThreadId.value = thread.id;
  const textBlock = getLastTextBlock(thread);
  textBlock.content = msg.content || '';
  if (msg.model) {
    thread.model = msg.model;
  }
  currentStreamIndex.value = null;
  currentAssistantThreadId.value = null;
  scrollToBottom();
};
