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
    autoScrollLocked,
    capabilityCheckProgress,
    connectionStatus,
    contextList,
    currentAssistantThreadId,
    currentMode,
    currentModel,
    currentPage,
    currentProgressIndex,
    currentSessionId,
    currentStreamIndex,
    dbMaintenanceStatus,
    deletingSessionIds,
    deletionProgress,
    filesChangedBlocks,
    hasToken,
    implicitFile,
    implicitSelection,
    isFirstRun,
    isSearching,
    modelInfo,
    modelOptions,
    pendingPlanContent,
    progressIndexStack,
    recreateMessagesStatus,
    scrollTargetMessageId,
    selectedSessionIds,
    selectionMode,
    sessions,
    sessionsCursor,
    sessionSensitiveFilePatterns,
    sessionsHasMore,
    sessionsInitialLoaded,
    sessionsLoading,
    settings,
    temperatureSlider,
    timeline,
    tokenUsage,
    vscode,
    warningBanner
} from '../state';
import { buildTimelineFromMessages } from '../timelineBuilder';
import type { InitMessage, LoadSessionMessagesMessage, SearchResultGroup } from '../types';
import { closeActiveThinkingGroup, resetActiveStreamBlock } from './streaming';
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
  pendingPlanContent.value = null;
};

export const handleLoadSessions = (msg: any) => {
  sessions.value = msg.sessions || [];
  sessionsHasMore.value = !!msg.hasMore;
  sessionsCursor.value = typeof msg.nextOffset === 'number' ? msg.nextOffset : null;
  sessionsLoading.value = false;
  sessionsInitialLoaded.value = true;
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
  progressIndexStack.value = [];
  currentStreamIndex.value = null;
  currentAssistantThreadId.value = null;
  if (!scrollTargetMessageId.value) {
    scrollToBottom();
  }

  // Request diff stats for any pending filesChanged blocks restored from history
  for (const block of filesChangedBlocks.value) {
    if (block.statsLoading && block.checkpointIds?.length) {
      for (const checkpointId of block.checkpointIds) {
        vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId });
      }
    }
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

export const handleClearMessages = (msg: any) => {
  timeline.value = [];
  filesChangedBlocks.value = [];
  currentStreamIndex.value = null;
  currentProgressIndex.value = null;
  progressIndexStack.value = [];
  currentAssistantThreadId.value = null;
  pendingPlanContent.value = null;
  closeActiveThinkingGroup();
  resetActiveStreamBlock();
  if (msg.sessionId) {
    currentSessionId.value = msg.sessionId;
  }
  setGenerating(false);
};

export const handleConnectionTestResult = (msg: any) => {
  showStatus(connectionStatus, msg.message || '', !!msg.success);
  if (Array.isArray(msg.models)) {
    modelInfo.value = msg.models;
    modelOptions.value = msg.models.filter((m: any) => m.enabled !== false).map((m: { name: string }) => m.name);
    syncModelSelection();
  }
};

export const handleModelEnabledChanged = (msg: any) => {
  if (Array.isArray(msg.models)) {
    modelInfo.value = msg.models;
    modelOptions.value = msg.models.filter((m: any) => m.enabled !== false).map((m: { name: string }) => m.name);
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

export const handleSessionDeleted = (msg: any) => {
  const sessionId = msg.sessionId;
  if (!sessionId) return;
  // Remove from sessions list (idempotent with optimistic removal)
  sessions.value = sessions.value.filter(s => s.id !== sessionId);
  // Clear from deleting set
  const newSet = new Set(deletingSessionIds.value);
  newSet.delete(sessionId);
  deletingSessionIds.value = newSet;
};

export const handleSessionsDeleted = (msg: any) => {
  const sessionIds: string[] = msg.sessionIds || [];
  if (sessionIds.length > 0) {
    const deletedSet = new Set(sessionIds);
    // Remove confirmed-deleted sessions from list
    sessions.value = sessions.value.filter(s => !deletedSet.has(s.id));
  }
  // Always clear UI state (handles both confirm and cancel)
  deletingSessionIds.value = new Set();
  selectionMode.value = false;
  selectedSessionIds.value = new Set();
  deletionProgress.value = null;
};

export const handleDeletionProgress = (msg: any) => {
  deletionProgress.value = {
    completed: msg.completed || 0,
    total: msg.total || 0
  };
};

export const handleNavigateToSettings = (msg: any) => {
  currentPage.value = 'settings';
  isFirstRun.value = !!msg.isFirstRun;
};

export const handleCapabilityCheckProgress = (msg: any) => {
  capabilityCheckProgress.running = true;
  capabilityCheckProgress.completed = msg.completed || 0;
  capabilityCheckProgress.total = msg.total || 0;
  if (Array.isArray(msg.models)) {
    modelInfo.value = msg.models;
  }
};

export const handleCapabilityCheckComplete = () => {
  capabilityCheckProgress.running = false;
};
