/**
 * Handlers for session list management: load, append, delete, search,
 * restore messages, and approval settings.
 *
 * Live chat state (generation, thinking, context) → ./chatState.ts
 * Settings/connection/model state → ./settingsSync.ts
 */
import {
    applySearchResults,
    scrollToBottom,
    setGenerating
} from '../actions/index';
import {
    autoApproveCommands,
    autoApproveConfirmVisible,
    autoApproveSensitiveEdits,
    currentAssistantThreadId,
    currentProgressIndex,
    currentSessionId,
    currentStreamIndex,
    deletingSessionIds,
    deletionProgress,
    filesChangedBlocks,
    isSearching,
    pendingPlanContent,
    progressIndexStack,
    scrollTargetMessageId,
    selectedSessionIds,
    selectionMode,
    sessionExplorerModel,
    sessions,
    sessionsCursor,
    sessionSensitiveFilePatterns,
    sessionsHasMore,
    sessionsInitialLoaded,
    sessionsLoading,
    timeline,
    vscode
} from '../state';
import { buildTimelineFromMessages } from '../timelineBuilder';
import type { LoadSessionMessagesMessage, SearchResultGroup } from '../types';
import { closeActiveThinkingGroup, resetActiveStreamBlock } from './streaming';

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
  sessionExplorerModel.value = msg.sessionExplorerModel ?? '';
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

export const handleSearchSessionsResult = (msg: any) => {
  isSearching.value = false;
  applySearchResults((msg.results || []) as SearchResultGroup[]);
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
