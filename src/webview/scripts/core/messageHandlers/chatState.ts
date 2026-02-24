/**
 * Handlers for live chat state: generation lifecycle, thinking indicators,
 * warning banners, message insertion, and editor context updates.
 *
 * Split from sessions.ts to keep that file focused on session list management.
 */
import {
    scrollToBottom,
    setGenerating,
    updateThinking
} from '../actions/index';
import {
    autoScrollLocked,
    contextList,
    currentAssistantThreadId,
    currentProgressIndex,
    currentSessionId,
    currentStreamIndex,
    implicitFile,
    implicitSelection,
    progressIndexStack,
    timeline,
    tokenUsage,
    warningBanner
} from '../state';
import { closeActiveThinkingGroup, resetActiveStreamBlock } from './streaming';
import { ensureAssistantThread, getLastTextBlock } from './threadUtils';

export const handleGenerationStarted = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    setGenerating(true);
    currentStreamIndex.value = null;
    currentProgressIndex.value = null;
    progressIndexStack.value = [];
    currentAssistantThreadId.value = null;
    // Reset scroll lock so auto-scroll is active for the new generation.
    // The user can still scroll up during streaming to pause auto-scroll.
    autoScrollLocked.value = false;
    // Reset token usage indicator for the new generation
    tokenUsage.visible = false;
    tokenUsage.promptTokens = 0;
    tokenUsage.completionTokens = 0;
    tokenUsage.contextWindow = 0;
    tokenUsage.categories = { system: 0, toolDefinitions: 0, messages: 0, toolResults: 0, files: 0, total: 0 };
  }
};

export const handleGenerationStopped = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    setGenerating(false);
    currentAssistantThreadId.value = null;
    // Finalize the thinking group but keep it OPEN so tool results remain
    // visible and clickable after generation ends (don't collapse).
    closeActiveThinkingGroup(/* collapse */ false);
    resetActiveStreamBlock();
  }
};

export const handleShowThinking = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    updateThinking(true, msg.message || 'Thinking...');
  }
};

export const handleHideThinking = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    updateThinking(false);
  }
};

/**
 * Show a transient warning banner at the top of the chat.
 * Not persisted — only shown during live session.
 */
export const handleShowWarningBanner = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    warningBanner.visible = true;
    warningBanner.message = msg.message || '';
  }
};

export const handleAddMessage = (msg: any) => {
  if (msg.sessionId && currentSessionId.value && msg.sessionId !== currentSessionId.value) {
    return;
  }
  if (msg.message?.role) {
    if (msg.message.role === 'assistant') {
      const thread = ensureAssistantThread(msg.message.model);
      const textBlock = getLastTextBlock(thread);
      textBlock.content = textBlock.content
        ? `${textBlock.content}\n\n${msg.message.content}`
        : msg.message.content;
      if (msg.message.model) {
        thread.model = msg.message.model;
      }
    } else {
      timeline.value.push({
        id: `msg_${Date.now()}`,
        type: 'message',
        role: msg.message.role,
        content: msg.message.content,
        model: msg.message.model,
        contextFiles: msg.contextFiles?.length ? msg.contextFiles : undefined
      });
      currentStreamIndex.value = null;
      currentProgressIndex.value = null;
      progressIndexStack.value = [];
      currentAssistantThreadId.value = null;
    }
    scrollToBottom();
  }
};

export const handleAddContextItem = (msg: any) => {
  if (msg.context) {
    // Deduplicate: skip if a context item with the same fileName already exists.
    // All backend addContext* handlers use asRelativePath, so exact match is sufficient.
    const isDuplicate = contextList.value.some(c => c.fileName === msg.context.fileName);
    if (!isDuplicate) {
      contextList.value.push(msg.context);
    }
  }
};

export const handleEditorContext = (msg: any) => {
  implicitFile.value = msg.activeFile ?? null;
  implicitSelection.value = msg.activeSelection ?? null;
};
