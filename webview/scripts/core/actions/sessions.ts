import { autoScrollLocked, currentMode, currentModel, currentPage, currentSessionId, scrollTargetMessageId, sessionsCursor, sessionsHasMore, sessionsLoading, vscode } from '../state';

export const showPage = (page: 'chat' | 'settings' | 'sessions') => {
  currentPage.value = page;
};

export const newChat = () => {
  vscode.postMessage({ type: 'newChat' });
};

export const addContext = () => {
  vscode.postMessage({ type: 'addContext' });
};

export const selectMode = () => {
  vscode.postMessage({ type: 'selectMode', mode: currentMode.value });
};

export const selectModel = () => {
  vscode.postMessage({ type: 'selectModel', model: currentModel.value });
};

export const loadSession = (id: string) => {
  showPage('chat');
  vscode.postMessage({ type: 'loadSession', sessionId: id });
};

export const deleteSession = (id: string) => {
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
