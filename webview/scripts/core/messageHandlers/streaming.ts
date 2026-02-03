import { scrollToBottom, startAssistantMessage } from '../actions/index';
import { currentSessionId, currentStreamIndex } from '../state';
import type { StreamChunkMessage } from '../types';
import { ensureAssistantThread } from './threadUtils';

export const handleStreamChunk = (msg: StreamChunkMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (currentStreamIndex.value === null) {
    startAssistantMessage(msg.model);
  }
  const thread = ensureAssistantThread(msg.model);
  if (thread.tools.length > 0) {
    thread.contentAfter = msg.content || '';
  } else {
    thread.contentBefore = msg.content || '';
  }
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
  if (thread.tools.length > 0) {
    thread.contentAfter = msg.content || '';
  } else {
    thread.contentBefore = msg.content || '';
  }
  if (msg.model) {
    thread.model = msg.model;
  }
  currentStreamIndex.value = null;
  scrollToBottom();
};
