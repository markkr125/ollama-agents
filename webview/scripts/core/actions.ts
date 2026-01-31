import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { nextTick } from 'vue';
import {
  agentSettings,
  agentStatus,
  allSearchResults,
  autoScrollLocked,
  bearerToken,
  contextList,
  currentMode,
  currentModel,
  currentPage,
  currentProgressIndex,
  currentStreamIndex,
  dbMaintenanceStatus,
  hasToken,
  inputEl,
  inputText,
  isGenerating,
  isSearching,
  messagesEl,
  modelsStatus,
  scrollTargetMessageId,
  searchIsRevealing,
  searchQuery,
  searchResults,
  searchVisibleCount,
  sessionsHasMore,
  sessionsLoading,
  sessionsOpen,
  settings,
  thinking,
  timeline,
  tokenVisible,
  vscode
} from './state';
import type { ActionItem, MessageItem, ProgressItem, SearchResultGroup, StatusMessage } from './types';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true
}).use(taskLists, { enabled: true, label: true, labelAfter: true });

const renderCodeBlock = (code: string, language: string) => {
  const normalizedLang = (language || '').trim() || 'text';
  const safeLang = markdown.utils.escapeHtml(normalizedLang);
  const safeCode = markdown.utils.escapeHtml(code);
  const languageClass = safeLang ? `language-${safeLang}` : '';

  return `
    <div class="code-block" data-lang="${safeLang}">
      <div class="code-header">
        <span class="code-lang">${safeLang}</span>
        <button class="code-copy-btn" data-copy-label="Copy" data-copied-label="Copied">Copy</button>
      </div>
      <pre><code class="${languageClass}">${safeCode}</code></pre>
    </div>
  `;
};

markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const language = info ? info.split(/\s+/)[0] : '';
  return renderCodeBlock(token.content, language);
};

markdown.renderer.rules.code_block = (tokens, idx) => {
  const token = tokens[idx];
  return renderCodeBlock(token.content, 'text');
};

export const statusClass = (status: StatusMessage) => {
  return {
    visible: status.visible,
    success: status.success,
    error: !status.success
  };
};

export const scrollToBottom = () => {
  nextTick(() => {
    if (scrollTargetMessageId.value || autoScrollLocked.value) {
      return;
    }
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  });
};

export const resizeInput = () => {
  if (!inputEl.value) return;
  inputEl.value.style.height = 'auto';
  inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 200) + 'px';
};

export const handleEnter = () => {
  if (!isGenerating.value) {
    handleSend();
  }
};

export const showPage = (page: 'chat' | 'settings') => {
  currentPage.value = page;
};

export const toggleSessions = () => {
  sessionsOpen.value = !sessionsOpen.value;
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

export const handleSend = () => {
  if (isGenerating.value) {
    vscode.postMessage({ type: 'stopGeneration' });
    return;
  }

  const text = inputText.value.trim();
  if (!text) return;

  const safeContext = contextList.value.map(item => ({
    fileName: item.fileName,
    content: item.content
  }));
  vscode.postMessage({ type: 'sendMessage', text, context: safeContext });
  inputText.value = '';
  resizeInput();
  contextList.value = [];
};

export const removeContext = (index: number) => {
  contextList.value.splice(index, 1);
};

export const toggleToken = () => {
  tokenVisible.value = !tokenVisible.value;
};

export const saveBearerToken = () => {
  if (!bearerToken.value) return;
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
  // Save token and test connection - backend will test after saving
  vscode.postMessage({ type: 'saveBearerToken', token: bearerToken.value, testAfterSave: true });
  hasToken.value = true;
};

export const testConnection = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
  vscode.postMessage({ type: 'testConnection' });
};

export const saveBaseUrl = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
};

export const saveModelSettings = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      agentModel: settings.agentModel,
      askModel: settings.askModel,
      editModel: settings.editModel,
      completionModel: settings.completionModel
    }
  });
  showStatus(modelsStatus, 'Model settings saved!', true);
};

export const saveAgentSettings = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      maxIterations: settings.maxIterations,
      toolTimeout: settings.toolTimeout,
      autoCreateBranch: agentSettings.autoCreateBranch,
      autoCommit: agentSettings.autoCommit
    }
  });
  showStatus(agentStatus, 'Agent settings saved!', true);
};

export const runDbMaintenance = () => {
  showStatus(dbMaintenanceStatus, 'Running database maintenance...', true);
  vscode.postMessage({ type: 'runDbMaintenance' });
};

export const toggleAutocomplete = () => {
  settings.enableAutoComplete = !settings.enableAutoComplete;
  vscode.postMessage({
    type: 'saveSettings',
    settings: { enableAutoComplete: settings.enableAutoComplete }
  });
};

export const actionStatusClass = (status: ActionItem['status']) => {
  return {
    running: status === 'running',
    done: status === 'success',
    error: status === 'error',
    pending: status === 'pending'
  };
};

export const toggleProgress = (item: ProgressItem) => {
  item.collapsed = !item.collapsed;
};

export const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const showStatus = (target: StatusMessage, message: string, success: boolean) => {
  target.message = message;
  target.success = success;
  target.visible = true;
  setTimeout(() => {
    target.visible = false;
  }, 3000);
};

export const formatMarkdown = (text: string) => {
  if (!text) return '';
  return markdown.render(text);
};

export const ensureProgressGroup = (title = 'Working on task') => {
  if (currentProgressIndex.value !== null) return;
  const group: ProgressItem = {
    id: `progress_${Date.now()}`,
    type: 'progress',
    title,
    status: 'running',
    collapsed: false,
    actions: [],
    lastActionStatus: undefined
  };
  timeline.value.push(group);
  currentProgressIndex.value = timeline.value.length - 1;
  scrollToBottom();
};

export const startAssistantMessage = (model?: string) => {
  const message: MessageItem = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: '',
    model
  };
  timeline.value.push(message);
  currentStreamIndex.value = timeline.value.length - 1;
  scrollToBottom();
};

export const loadSession = (id: string) => {
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

export const updateThinking = (visible: boolean, message?: string) => {
  thinking.visible = visible;
  if (message) {
    thinking.text = message;
  }
};

export const clearToken = () => {
  bearerToken.value = '';
};

export const setGenerating = (value: boolean) => {
  isGenerating.value = value;
  if (!value) {
    updateThinking(false);
  }
};

export const updateInitState = (msg: any) => {
  const models = (msg.models || []).map((m: { name: string }) => m.name);
  return models;
};

export const applySettings = (msg: any) => {
  if (!msg.settings) return;
  settings.baseUrl = msg.settings.baseUrl || 'http://localhost:11434';
  settings.enableAutoComplete = !!msg.settings.enableAutoComplete;
  settings.agentModel = msg.settings.agentModel || '';
  settings.askModel = msg.settings.askModel || '';
  settings.editModel = msg.settings.editModel || '';
  settings.completionModel = msg.settings.completionModel || '';
  settings.maxIterations = msg.settings.maxIterations || settings.maxIterations;
  settings.toolTimeout = msg.settings.toolTimeout || settings.toolTimeout;
  settings.temperature = msg.settings.temperature ?? settings.temperature;
};

// Session search actions
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SEARCH_PAGE_SIZE = 20;

const getSearchTotalCount = (groups: SearchResultGroup[]) =>
  groups.reduce((sum, group) => sum + group.messages.length, 0);

const buildVisibleSearchResults = (groups: SearchResultGroup[], maxMessages: number) => {
  if (maxMessages <= 0) return [];
  const visible: SearchResultGroup[] = [];
  let remaining = maxMessages;

  for (const group of groups) {
    if (remaining <= 0) break;
    const messages = group.messages.slice(0, remaining);
    if (messages.length > 0) {
      visible.push({ session: group.session, messages });
      remaining -= messages.length;
    }
  }

  return visible;
};

const updateVisibleSearchResults = () => {
  searchResults.value = buildVisibleSearchResults(allSearchResults.value, searchVisibleCount.value);
};

const resetSearchState = () => {
  allSearchResults.value = [];
  searchResults.value = [];
  searchVisibleCount.value = SEARCH_PAGE_SIZE;
  searchIsRevealing.value = false;
};

export const applySearchResults = (groups: SearchResultGroup[]) => {
  allSearchResults.value = groups;
  const total = getSearchTotalCount(groups);
  searchVisibleCount.value = Math.min(SEARCH_PAGE_SIZE, total);
  searchIsRevealing.value = false;
  updateVisibleSearchResults();
};

export const revealMoreSearchResults = () => {
  const total = getSearchTotalCount(allSearchResults.value);
  if (searchVisibleCount.value >= total) return;
  searchIsRevealing.value = true;
  searchVisibleCount.value = Math.min(searchVisibleCount.value + SEARCH_PAGE_SIZE, total);
  updateVisibleSearchResults();
  setTimeout(() => {
    searchIsRevealing.value = false;
  }, 150);
};

export const handleSearchInput = (query: string) => {
  searchQuery.value = query;
  
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  
  if (!query.trim()) {
    resetSearchState();
    isSearching.value = false;
    return;
  }
  
  isSearching.value = true;
  resetSearchState();
  searchDebounceTimer = setTimeout(() => {
    vscode.postMessage({ type: 'searchSessions', query: query.trim() });
  }, 300);
};

export const clearSearch = () => {
  searchQuery.value = '';
  resetSearchState();
  isSearching.value = false;
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
};

export const clearScrollTarget = () => {
  scrollTargetMessageId.value = null;
  setTimeout(() => {
    autoScrollLocked.value = false;
  }, 300);
};

export const loadSessionWithMessage = (sessionId: string, messageId: string) => {
  autoScrollLocked.value = true;
  scrollTargetMessageId.value = messageId;
  vscode.postMessage({ type: 'loadSession', sessionId });
};

export const highlightSnippet = (snippet: string, query: string): string => {
  if (!query.trim()) return snippet;
  
  const words = query.trim().split(/\s+/).filter(w => w.length > 2);
  let result = snippet;
  
  for (const word of words) {
    const regex = new RegExp(`(${word})`, 'gi');
    result = result.replace(regex, '<mark>$1</mark>');
  }
  
  return result;
};
