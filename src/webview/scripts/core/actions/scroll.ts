import { nextTick } from 'vue';
import { autoScrollLocked, inputEl, messagesEl, scrollTargetMessageId } from '../state';

export const scrollToBottom = () => {
  nextTick(() => {
    if (scrollTargetMessageId.value || autoScrollLocked.value) {
      return;
    }
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
    // Also auto-scroll the inner content of an actively streaming thinking group
    const streamingContent = document.querySelector('.thinking-group.is-streaming .thinking-group-content');
    if (streamingContent) {
      streamingContent.scrollTop = streamingContent.scrollHeight;
    }
  });
};

export const resizeInput = (element?: HTMLTextAreaElement | null) => {
  const target = element ?? inputEl.value ?? null;
  if (!target) return;
  target.style.height = 'auto';
  target.style.height = Math.min(target.scrollHeight, 200) + 'px';
};

export const clearScrollTarget = () => {
  scrollTargetMessageId.value = null;
  setTimeout(() => {
    autoScrollLocked.value = false;
  }, 300);
};
