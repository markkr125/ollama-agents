import {
    applySettings,
    clearToken,
    ensureProgressGroup,
    scrollToBottom,
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
    modelOptions,
    sessions,
    settings,
    temperatureSlider,
    timeline
} from '../core/state';
import type { MessageItem, ProgressItem } from '../core/types';

export * from '../core/actions';
export * from '../core/computed';
export * from '../core/state';

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
      hasToken.value = !!msg.hasToken;
      break;
    }

    case 'loadSessions':
      sessions.value = msg.sessions || [];
      break;

    case 'loadSessionMessages':
      timeline.value = (msg.messages || []).map((m: any) => ({
        id: `msg_${Date.now()}_${Math.random()}`,
        type: 'message',
        role: m.role,
        content: m.content
      }));
      currentProgressIndex.value = null;
      currentStreamIndex.value = null;
      scrollToBottom();
      break;

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
        group.actions.push({
          id: `action_${Date.now()}_${Math.random()}`,
          status: msg.status || 'running',
          icon: msg.icon || '•',
          text: msg.text || '',
          detail: msg.detail || null
        });
        scrollToBottom();
      }
      break;

    case 'finishProgressGroup':
      if (currentProgressIndex.value !== null) {
        const group = timeline.value[currentProgressIndex.value] as ProgressItem;
        group.status = 'done';
      }
      currentProgressIndex.value = null;
      break;

    case 'streamChunk':
      if (currentStreamIndex.value === null) {
        startAssistantMessage();
      }
      if (currentStreamIndex.value !== null) {
        const message = timeline.value[currentStreamIndex.value] as MessageItem;
        message.content = msg.content || '';
        scrollToBottom();
      }
      break;

    case 'finalMessage':
      if (currentStreamIndex.value === null) {
        startAssistantMessage();
      }
      if (currentStreamIndex.value !== null) {
        const message = timeline.value[currentStreamIndex.value] as MessageItem;
        message.content = msg.content || '';
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
        group.actions.push({
          id: `action_${Date.now()}_${Math.random()}`,
          status: 'error',
          icon: '✗',
          text: msg.message || 'Error',
          detail: null
        });
      }
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
      hasToken.value = !!msg.hasToken;
      break;
  }
});
