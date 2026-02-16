import { autoScrollLocked, currentMode, currentModel, currentPage, currentSessionId, deletingSessionIds, scrollTargetMessageId, selectedSessionIds, selectionMode, sessions, sessionsCursor, sessionsHasMore, sessionsLoading, timeline, vscode } from '../state';

export const showPage = (page: 'chat' | 'settings' | 'sessions') => {
  currentPage.value = page;
};

export const newChat = () => {
  // Prevent duplicate idle sessions: if current session is idle with no content, just navigate
  if (currentSessionId.value) {
    const currentSess = sessions.value.find(s => s.id === currentSessionId.value);
    if (currentSess?.status === 'idle' && timeline.value.length <= 1) {
      currentPage.value = 'chat';
      return;
    }
  }
  currentPage.value = 'chat';
  vscode.postMessage({ type: 'newChat' });
};

export const addContext = () => {
  vscode.postMessage({ type: 'addContext' });
};

export const addContextFromFile = () => {
  vscode.postMessage({ type: 'addContextFromFile' });
};

export const addContextCurrentFile = () => {
  vscode.postMessage({ type: 'addContextCurrentFile' });
};

export const addContextFromTerminal = () => {
  vscode.postMessage({ type: 'addContextFromTerminal' });
};

export const selectMode = () => {
  vscode.postMessage({ type: 'selectMode', mode: currentMode.value });
};

export const selectModel = () => {
  vscode.postMessage({ type: 'selectModel', model: currentModel.value });
};

export const loadSession = (id: string) => {
  currentSessionId.value = id;
  showPage('chat');
  vscode.postMessage({ type: 'loadSession', sessionId: id });
};

export const deleteSession = (id: string) => {
  deletingSessionIds.value.add(id);
  // Optimistically remove from sessions list
  sessions.value = sessions.value.filter(s => s.id !== id);
  vscode.postMessage({ type: 'deleteSession', sessionId: id });
};

export const loadMoreSessions = () => {
  if (sessionsLoading.value || !sessionsHasMore.value) return;
  sessionsLoading.value = true;
  vscode.postMessage({ type: 'loadMoreSessions', offset: sessionsCursor.value ?? 0 });
};

export const updateSessionSensitivePatterns = (patterns: string) => {
  if (!currentSessionId.value) return;
  vscode.postMessage({
    type: 'updateSessionSensitivePatterns',
    sessionId: currentSessionId.value,
    patterns
  });
};

export const loadSessionWithMessage = (sessionId: string, messageId: string) => {
  autoScrollLocked.value = true;
  scrollTargetMessageId.value = messageId;
  showPage('chat');
  vscode.postMessage({ type: 'loadSession', sessionId });
};

export const getActiveSessionId = () => currentSessionId.value;

// Multi-select session management
export const toggleSelectionMode = () => {
  selectionMode.value = !selectionMode.value;
  if (!selectionMode.value) {
    selectedSessionIds.value = new Set();
  }
};

export const toggleSessionSelection = (id: string) => {
  const newSet = new Set(selectedSessionIds.value);
  if (newSet.has(id)) {
    newSet.delete(id);
  } else {
    newSet.add(id);
  }
  selectedSessionIds.value = newSet;
};

export const selectAllSessions = () => {
  selectedSessionIds.value = new Set(sessions.value.map(s => s.id));
};

export const clearSelection = () => {
  selectionMode.value = false;
  selectedSessionIds.value = new Set();
};

export const deleteSelectedSessions = () => {
  const ids = Array.from(selectedSessionIds.value);
  if (ids.length === 0) return;
  // Mark sessions as deleting (visual feedback) but don't remove from list yet.
  // Actual removal happens when backend confirms via 'sessionsDeleted' message.
  const newDeleting = new Set(deletingSessionIds.value);
  ids.forEach(id => newDeleting.add(id));
  deletingSessionIds.value = newDeleting;
  vscode.postMessage({ type: 'deleteMultipleSessions', sessionIds: ids });
};
