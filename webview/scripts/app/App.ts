import {
  applySettings,
  clearToken,
  ensureProgressGroup,
  scrollToBottom,
  selectModel,
  setGenerating,
  showStatus,
  startAssistantMessage,
  updateInitState,
  updateThinking
} from '../core/actions';
import {
  connectionStatus,
  contextList,
  currentMode,
  currentModel,
  currentProgressIndex,
  currentStreamIndex,
  hasToken,
  isSearching,
  modelOptions,
  searchResults,
  sessions,
  settings,
  temperatureSlider,
  timeline
} from '../core/state';
import type { MessageItem, ProgressItem, SearchResultGroup } from '../core/types';

export * from '../core/actions';
export * from '../core/computed';
export * from '../core/state';

const syncModelSelection = () => {
  if (modelOptions.value.length === 0) return;
  const preferred = currentModel.value || settings.agentModel || modelOptions.value[0];
  const nextModel = modelOptions.value.includes(preferred) ? preferred : modelOptions.value[0];
  if (nextModel !== currentModel.value) {
    currentModel.value = nextModel;
  }
  selectModel();
};

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      modelOptions.value = updateInitState(msg);
      if (msg.currentMode) currentMode.value = msg.currentMode;
      applySettings(msg);
      temperatureSlider.value = Math.round(settings.temperature * 100);
      if (settings.agentModel) {
        currentModel.value = settings.agentModel;
      }
      syncModelSelection();
      hasToken.value = !!msg.hasToken;
      break;
    }

    case 'loadSessions':
      sessions.value = msg.sessions || [];
      break;

    case 'loadSessionMessages': {
      const items: any[] = [];
      let currentProgressGroup: any = null;
      
      for (const m of (msg.messages || [])) {
        if (m.role === 'tool') {
          // Group consecutive tool messages into progress groups
          if (!currentProgressGroup) {
            currentProgressGroup = {
              id: `progress_${m.id}`,
              type: 'progress',
              title: 'Tool executions',
              status: 'done',
              collapsed: true,
              actions: []
            };
            items.push(currentProgressGroup);
          }
          
          // Add tool as action
          const isError = m.content?.startsWith('Error:');
          currentProgressGroup.actions.push({
            id: m.id,
            status: isError ? 'error' : 'success',
            icon: '📄',
            text: m.toolName || 'Tool',
            detail: m.content?.split('\n')[0]?.substring(0, 50) || null
          });
        } else {
          // Close any open progress group
          currentProgressGroup = null;
          
          // Add regular message
          items.push({
            id: m.id || `msg_${Date.now()}_${Math.random()}`,
            type: 'message',
            role: m.role,
            content: m.content,
            model: m.model
          });
        }
      }
      
      timeline.value = items;
      currentProgressIndex.value = null;
      currentStreamIndex.value = null;
      scrollToBottom();
      break;
    }

    case 'addMessage':
      if (msg.message?.role === 'user') {
        timeline.value.push({
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'user',
          content: msg.message.content
        });
        scrollToBottom();
      }
      break;

    case 'showThinking':
      updateThinking(true, msg.message || 'Thinking...');
      break;

    case 'hideThinking':
      updateThinking(false);
      break;

    case 'startProgressGroup':
      ensureProgressGroup(msg.title || 'Working on task');
      break;

    case 'showToolAction':
      ensureProgressGroup('Working on task');
      if (currentProgressIndex.value !== null) {
        const group = timeline.value[currentProgressIndex.value] as ProgressItem;
        const actionText = msg.text || '';
        const existingIndex = group.actions.findIndex(actionItem =>
          (actionItem.status === 'running' || actionItem.status === 'pending') &&
          actionItem.text === actionText
        );
        const lastRunningIndex = existingIndex >= 0
          ? existingIndex
          : [...group.actions].reverse().findIndex(actionItem => actionItem.status === 'running' || actionItem.status === 'pending');
        const resolvedIndex = lastRunningIndex >= 0
          ? group.actions.length - 1 - lastRunningIndex
          : -1;
        const action = {
          id: `action_${Date.now()}_${Math.random()}`,
          status: msg.status || 'running',
          icon: msg.icon || '•',
          text: actionText,
          detail: msg.detail || null
        };
        if (action.status !== 'running' && action.status !== 'pending') {
          if (existingIndex >= 0) {
            group.actions[existingIndex] = { ...group.actions[existingIndex], ...action };
          } else if (resolvedIndex >= 0) {
            group.actions[resolvedIndex] = { ...group.actions[resolvedIndex], ...action };
          } else {
            group.actions.push(action);
          }
        } else {
          group.actions.push(action);
          group.status = 'running';
        }
        group.lastActionStatus = action.status;
        scrollToBottom();
      }
      break;

    case 'finishProgressGroup':
      if (currentProgressIndex.value !== null) {
        const group = timeline.value[currentProgressIndex.value] as ProgressItem;
        group.status = 'done';
        group.collapsed = true;
        const lastAction = group.actions[group.actions.length - 1];
        group.lastActionStatus = lastAction?.status || 'success';
      }
      currentProgressIndex.value = null;
      break;

    case 'streamChunk':
      if (currentStreamIndex.value === null) {
        startAssistantMessage(msg.model);
      }
      if (currentStreamIndex.value !== null) {
        const message = timeline.value[currentStreamIndex.value] as MessageItem;
        message.content = msg.content || '';
        if (msg.model) {
          message.model = msg.model;
        }
        scrollToBottom();
      }
      break;

    case 'finalMessage':
      if (currentStreamIndex.value === null) {
        startAssistantMessage(msg.model);
      }
      if (currentStreamIndex.value !== null) {
        const message = timeline.value[currentStreamIndex.value] as MessageItem;
        message.content = msg.content || '';
        if (msg.model) {
          message.model = msg.model;
        }
        currentStreamIndex.value = null;
        scrollToBottom();
      }
      break;

    case 'generationStarted':
      setGenerating(true);
      break;

    case 'generationStopped':
      setGenerating(false);
      break;

    case 'addContextItem':
      if (msg.context) {
        contextList.value.push(msg.context);
      }
      break;

    case 'showError':
      ensureProgressGroup('Working on task');
      if (currentProgressIndex.value !== null) {
        const group = timeline.value[currentProgressIndex.value] as ProgressItem;
        const action = {
          id: `action_${Date.now()}_${Math.random()}`,
          status: 'error',
          icon: '✗',
          text: msg.message || 'Error',
          detail: null
        };
        group.actions.push(action);
        group.lastActionStatus = action.status;
        group.status = 'error';
        group.collapsed = true;
      }
      currentProgressIndex.value = null;
      break;

    case 'clearMessages':
      timeline.value = [];
      currentStreamIndex.value = null;
      currentProgressIndex.value = null;
      break;

    case 'connectionTestResult':
      showStatus(connectionStatus, msg.message || '', !!msg.success);
      if (Array.isArray(msg.models)) {
        modelOptions.value = msg.models.map((m: { name: string }) => m.name);
        syncModelSelection();
      }
      break;

    case 'bearerTokenSaved':
      clearToken();
      break;

    case 'connectionError':
      showStatus(connectionStatus, `Connection error: ${msg.error}`, false);
      break;

    case 'settingsUpdate':
      applySettings(msg);
      temperatureSlider.value = Math.round(settings.temperature * 100);
      if (settings.agentModel) {
        currentModel.value = settings.agentModel;
      }
      syncModelSelection();
      hasToken.value = !!msg.hasToken;
      break;

    case 'searchSessionsResult':
      isSearching.value = false;
      searchResults.value = (msg.results || []) as SearchResultGroup[];
      break;
  }
});
