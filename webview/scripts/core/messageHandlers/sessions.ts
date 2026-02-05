import {
    applySearchResults,
    applySettings,
    clearToken,
    scrollToBottom,
    setGenerating,
    showStatus,
    updateInitState,
    updateThinking
} from '../actions/index';
import {
    autoApproveCommands,
    autoApproveConfirmVisible,
    autoApproveSensitiveEdits,
    connectionStatus,
    contextList,
    currentAssistantThreadId,
    currentMode,
    currentModel,
    currentProgressIndex,
    currentSessionId,
    currentStreamIndex,
    dbMaintenanceStatus,
    hasToken,
    isSearching,
    modelOptions,
    recreateMessagesStatus,
    scrollTargetMessageId,
    sessions,
    sessionsCursor,
    sessionSensitiveFilePatterns,
    sessionsHasMore,
    sessionsLoading,
    settings,
    temperatureSlider,
    timeline
} from '../state';
import { buildTimelineFromMessages } from '../timelineBuilder';
import type { InitMessage, LoadSessionMessagesMessage, SearchResultGroup } from '../types';
import { ensureAssistantThread, getLastTextBlock, syncModelSelection } from './threadUtils';

export const handleInit = (msg: InitMessage) => {
  modelOptions.value = updateInitState(msg);
  if (msg.currentMode) currentMode.value = msg.currentMode;
  applySettings(msg);
  temperatureSlider.value = Math.round(settings.temperature * 100);
  if (settings.agentModel) {
    currentModel.value = settings.agentModel;
  }
  syncModelSelection();
  hasToken.value = !!msg.hasToken;
};

export const handleLoadSessions = (msg: any) => {
  sessions.value = msg.sessions || [];
  sessionsHasMore.value = !!msg.hasMore;
  sessionsCursor.value = typeof msg.nextOffset === 'number' ? msg.nextOffset : null;
  sessionsLoading.value = false;
  if (Array.isArray(sessions.value)) {
    const active = sessions.value.find(session => session.active);
    if (active) {
      currentSessionId.value = active.id;
    }
  }
};

export const handleAppendSessions = (msg: any) => {
  sessions.value = [...sessions.value, ...(msg.sessions || [])];
  sessionsHasMore.value = !!msg.hasMore;
  sessionsCursor.value = typeof msg.nextOffset === 'number' ? msg.nextOffset : sessionsCursor.value;
  sessionsLoading.value = false;
};

export const handleUpdateSessionStatus = (msg: any) => {
  sessions.value = sessions.value.map(session =>
    session.id === msg.sessionId
      ? { ...session, status: msg.status }
      : session
  );
};

export const handleLoadSessionMessages = (msg: LoadSessionMessagesMessage) => {
  console.log('[loadSessionMessages]', {
    sessionId: msg.sessionId,
    messageCount: msg.messages?.length || 0,
    autoApprove: msg.autoApproveCommands
  });
  console.log('[loadSessionMessages] Message order received:', (msg.messages || []).map((m: any) => ({
    id: m.id?.substring(0, 8),
    role: m.role,
    timestamp: m.timestamp,
    tool: m.toolName || '-'
  })));
  const messages = msg.messages || [];
  if (msg.sessionId) {
    currentSessionId.value = msg.sessionId;
  }
  if (typeof msg.autoApproveCommands === 'boolean') {
    autoApproveCommands.value = msg.autoApproveCommands;
    autoApproveConfirmVisible.value = false;
  }
  if (typeof msg.autoApproveSensitiveEdits === 'boolean') {
    autoApproveSensitiveEdits.value = msg.autoApproveSensitiveEdits;
  }
  if (typeof msg.sessionSensitiveFilePatterns === 'string') {
    sessionSensitiveFilePatterns.value = msg.sessionSensitiveFilePatterns;
  } else if (msg.sessionSensitiveFilePatterns === null) {
    sessionSensitiveFilePatterns.value = '';
  }
  timeline.value = buildTimelineFromMessages(messages);
  currentProgressIndex.value = null;
  currentStreamIndex.value = null;
  currentAssistantThreadId.value = null;
  if (!scrollTargetMessageId.value) {
    scrollToBottom();
  }
};

export const handleSessionApprovalSettings = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    autoApproveCommands.value = !!msg.autoApproveCommands;
    if (typeof msg.autoApproveSensitiveEdits === 'boolean') {
      autoApproveSensitiveEdits.value = !!msg.autoApproveSensitiveEdits;
    }
    if (typeof msg.sessionSensitiveFilePatterns === 'string') {
      sessionSensitiveFilePatterns.value = msg.sessionSensitiveFilePatterns;
    } else if (msg.sessionSensitiveFilePatterns === null) {
      sessionSensitiveFilePatterns.value = '';
    }
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
        model: msg.message.model
      });
      currentStreamIndex.value = null;
      currentProgressIndex.value = null;
      currentAssistantThreadId.value = null;
    }
    scrollToBottom();
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

export const handleGenerationStarted = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    setGenerating(true);
    currentStreamIndex.value = null;
    currentProgressIndex.value = null;
    currentAssistantThreadId.value = null;
  }
};

export const handleGenerationStopped = (msg: any) => {
  if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
    setGenerating(false);
    currentAssistantThreadId.value = null;
  }
};

export const handleAddContextItem = (msg: any) => {
  if (msg.context) {
    contextList.value.push(msg.context);
  }
};

export const handleClearMessages = (msg: any) => {
  timeline.value = [];
  currentStreamIndex.value = null;
  currentProgressIndex.value = null;
  currentAssistantThreadId.value = null;
  if (msg.sessionId) {
    currentSessionId.value = msg.sessionId;
  }
  setGenerating(false);
};

export const handleConnectionTestResult = (msg: any) => {
  showStatus(connectionStatus, msg.message || '', !!msg.success);
  if (Array.isArray(msg.models)) {
    modelOptions.value = msg.models.map((m: { name: string }) => m.name);
    syncModelSelection();
  }
};

export const handleBearerTokenSaved = () => {
  clearToken();
};

export const handleConnectionError = (msg: any) => {
  showStatus(connectionStatus, `Connection error: ${msg.error}`, false);
};

export const handleSettingsUpdate = (msg: any) => {
  applySettings(msg);
  temperatureSlider.value = Math.round(settings.temperature * 100);
  if (settings.agentModel) {
    currentModel.value = settings.agentModel;
  }
  syncModelSelection();
  hasToken.value = !!msg.hasToken;
};

export const handleSearchSessionsResult = (msg: any) => {
  isSearching.value = false;
  applySearchResults((msg.results || []) as SearchResultGroup[]);
};

export const handleDbMaintenanceResult = (msg: any) => {
  const success = !!msg.success;
  const deletedSessions = msg.deletedSessions ?? 0;
  const deletedMessages = msg.deletedMessages ?? 0;
  const message = success
    ? `Maintenance complete. Removed ${deletedSessions} session(s), ${deletedMessages} message(s).`
    : (msg.message || 'Database maintenance failed.');
  showStatus(dbMaintenanceStatus, message, success);
};

export const handleRecreateMessagesResult = (msg: any) => {
  const success = !!msg.success;
  const message = msg.message || (success ? 'Messages table recreated.' : 'Failed to recreate messages table.');
  showStatus(recreateMessagesStatus, message, success);
};
