import {
  applySearchResults,
  applySettings,
  clearToken,
  scrollToBottom,
  selectModel,
  setGenerating,
  showStatus,
  startAssistantMessage,
  updateInitState,
  updateThinking
} from '../core/actions';
import {
  autoApproveCommands,
  autoApproveConfirmVisible,
  connectionStatus,
  contextList,
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
  sessionsHasMore,
  sessionsLoading,
  settings,
  temperatureSlider,
  timeline
} from '../core/state';
import type {
  ActionItem,
  AssistantThreadItem,
  CommandApprovalItem,
  ProgressItem,
  SearchResultGroup
} from '../core/types';

export * from '../core/actions';
export * from '../core/computed';
export * from '../core/state';

const getActiveAssistantThread = (): AssistantThreadItem | null => {
  if (currentStreamIndex.value !== null) {
    const item = timeline.value[currentStreamIndex.value];
    if (item && item.type === 'assistantThread') {
      return item as AssistantThreadItem;
    }
  }
  for (let i = timeline.value.length - 1; i >= 0; i--) {
    const item = timeline.value[i];
    if (item.type === 'assistantThread') {
      return item as AssistantThreadItem;
    }
  }
  return null;
};

const ensureAssistantThread = (model?: string): AssistantThreadItem => {
  let thread = getActiveAssistantThread();
  if (!thread) {
    startAssistantMessage(model);
    thread = getActiveAssistantThread();
  }
  return thread as AssistantThreadItem;
};

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
      sessionsHasMore.value = !!msg.hasMore;
      sessionsCursor.value = typeof msg.nextOffset === 'number' ? msg.nextOffset : null;
      sessionsLoading.value = false;
      if (Array.isArray(sessions.value)) {
        const active = sessions.value.find(session => session.active);
        if (active) {
          currentSessionId.value = active.id;
        }
      }
      break;

    case 'appendSessions':
      sessions.value = [...sessions.value, ...(msg.sessions || [])];
      sessionsHasMore.value = !!msg.hasMore;
      sessionsCursor.value = typeof msg.nextOffset === 'number' ? msg.nextOffset : sessionsCursor.value;
      sessionsLoading.value = false;
      break;

    case 'updateSessionStatus':
      sessions.value = sessions.value.map(session =>
        session.id === msg.sessionId
          ? { ...session, status: msg.status }
          : session
      );
      break;

    case 'loadSessionMessages': {
      console.log('[loadSessionMessages]', {
        sessionId: msg.sessionId,
        messageCount: msg.messages?.length || 0,
        autoApprove: msg.autoApproveCommands
      });
      // Debug: Log message order as received
      console.log('[loadSessionMessages] Message order received:', (msg.messages || []).map((m: any) => ({
        id: m.id?.substring(0, 8),
        role: m.role,
        timestamp: m.timestamp,
        tool: m.toolName || '-'
      })));
      const items: any[] = [];
      const messages = msg.messages || [];
      if (msg.sessionId) {
        currentSessionId.value = msg.sessionId;
      }
      if (typeof msg.autoApproveCommands === 'boolean') {
        autoApproveCommands.value = msg.autoApproveCommands;
        autoApproveConfirmVisible.value = false;
      }

      const getProgressTitleForTools = (toolNames: string[]) => {
        const hasRead = toolNames.includes('read_file');
        const hasWrite = toolNames.includes('write_file') || toolNames.includes('create_file');
        const hasSearch = toolNames.includes('search_workspace');
        const hasCommand = toolNames.includes('run_terminal_command') || toolNames.includes('run_command');
        const hasListFiles = toolNames.includes('list_files');

        if (hasSearch) return 'Searching codebase';
        if (hasWrite && hasRead) return 'Modifying files';
        if (hasWrite) return 'Writing files';
        if (hasRead && toolNames.length > 1) return 'Reading files';
        if (hasRead) return 'Analyzing code';
        if (hasListFiles) return 'Exploring workspace';
        if (hasCommand) return 'Running commands';
        return 'Executing task';
      };

      const buildCommandApprovalItem = (toolMessage: any): CommandApprovalItem | null => {
        let toolInput: any = {};
        if (toolMessage.toolInput) {
          try {
            toolInput = JSON.parse(toolMessage.toolInput);
          } catch {
            toolInput = {};
          }
        }
        const command = toolInput?.command || '';
        if (!command) return null;
        const output = toolMessage.toolOutput || toolMessage.content || '';
        const skipped = (output || '').toLowerCase().includes('skipped by user');
        const exitMatch = (output || '').match(/Exit code:\s*(\d+)/i);
        const exitCode = exitMatch ? Number(exitMatch[1]) : null;

        return {
          id: `approval_${toolMessage.id}`,
          type: 'commandApproval',
          command,
          cwd: toolInput?.cwd || '',
          severity: 'medium',
          reason: toolMessage.actionDetail || undefined,
          status: skipped ? 'skipped' : 'approved',
          timestamp: toolMessage.timestamp || Date.now(),
          output,
          exitCode
        };
      };

      let currentThread: AssistantThreadItem | null = null;

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'user') {
          items.push({
            id: m.id || `msg_${Date.now()}_${Math.random()}`,
            type: 'message',
            role: 'user',
            content: m.content,
            model: m.model
          });
          currentThread = null;
          continue;
        }

        if (m.role === 'assistant') {
          if (!currentThread) {
            currentThread = {
              id: m.id || `msg_${Date.now()}_${Math.random()}`,
              type: 'assistantThread',
              role: 'assistant',
              contentBefore: m.content || '',
              contentAfter: '',
              model: m.model,
              tools: []
            };
            items.push(currentThread);
          } else if (currentThread.tools.length > 0) {
            currentThread.contentAfter = currentThread.contentAfter
              ? `${currentThread.contentAfter}\n\n${m.content || ''}`
              : (m.content || '');
          } else {
            currentThread.contentBefore = currentThread.contentBefore
              ? `${currentThread.contentBefore}\n\n${m.content || ''}`
              : (m.content || '');
          }
          if (m.model) {
            currentThread.model = m.model;
          }
          continue;
        }

        // Tool message
        if (!currentThread) {
          currentThread = {
            id: `msg_${Date.now()}_${Math.random()}`,
            type: 'assistantThread',
            role: 'assistant',
            contentBefore: '',
            contentAfter: '',
            model: m.model,
            tools: []
          };
          items.push(currentThread);
        }

        const toolBlock: any[] = [];
        let j = i;
        while (j < messages.length && messages[j].role === 'tool') {
          toolBlock.push(messages[j]);
          j++;
        }

        const commandTools = toolBlock.filter(toolMessage =>
          toolMessage.toolName === 'run_terminal_command' || toolMessage.toolName === 'run_command'
        );

        if (commandTools.length > 0) {
          const cmdProgressGroup = {
            id: `progress_cmd_${m.id}`,
            type: 'progress',
            title: 'Running commands',
            status: commandTools.some(toolMessage =>
              (toolMessage.actionStatus ? toolMessage.actionStatus === 'error' : toolMessage.content?.startsWith('Error:'))
            ) ? 'error' : 'done',
            collapsed: true,
            actions: commandTools.map(toolMessage => ({
              id: toolMessage.id,
              status: toolMessage.content?.startsWith('Error:') ? 'error' : 'success',
              icon: '💻',
              text: 'Terminal command',
              detail: null
            })) as ActionItem[]
          };
          currentThread.tools.push(cmdProgressGroup);

          const commandItems = commandTools
            .map(buildCommandApprovalItem)
            .filter(Boolean) as CommandApprovalItem[];
          for (const commandItem of commandItems) {
            currentThread.tools.push(commandItem);
          }
        }

        const nonCommandTools = toolBlock.filter(toolMessage =>
          toolMessage.toolName !== 'run_terminal_command' && toolMessage.toolName !== 'run_command'
        );

        if (nonCommandTools.length > 0) {
          const toolNames = nonCommandTools
            .map(toolMessage => toolMessage.toolName)
            .filter(Boolean);
          const storedTitle = nonCommandTools.find(toolMessage => toolMessage.progressTitle)?.progressTitle;
          const groupTitle = storedTitle || getProgressTitleForTools(toolNames);

          const progressGroup = {
            id: `progress_${m.id}`,
            type: 'progress',
            title: groupTitle,
            status: nonCommandTools.some(toolMessage =>
              (toolMessage.actionStatus ? toolMessage.actionStatus === 'error' : toolMessage.content?.startsWith('Error:'))
            ) ? 'error' : 'done',
            collapsed: true,
            actions: [] as ActionItem[]
          };

          for (const toolMessage of nonCommandTools) {
            const isError = toolMessage.actionStatus
              ? toolMessage.actionStatus === 'error'
              : toolMessage.content?.startsWith('Error:');
            progressGroup.actions.push({
              id: toolMessage.id,
              status: isError ? 'error' : 'success',
              icon: toolMessage.actionIcon || '📄',
              text: toolMessage.actionText || toolMessage.toolName || 'Tool',
              detail: toolMessage.actionDetail || toolMessage.content?.split('\n')[0]?.substring(0, 50) || null
            });
          }

          currentThread.tools.push(progressGroup);
        }

        i = j - 1;
      }
      timeline.value = items;
      currentProgressIndex.value = null;
      currentStreamIndex.value = null;
      if (!scrollTargetMessageId.value) {
        scrollToBottom();
      }
      break;
    }

    case 'requestToolApproval':
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      if (msg.approval) {
        const item: CommandApprovalItem = {
          id: msg.approval.id,
          type: 'commandApproval',
          command: msg.approval.command,
          cwd: msg.approval.cwd,
          severity: msg.approval.severity || 'medium',
          reason: msg.approval.reason,
          status: 'pending',
          timestamp: msg.approval.timestamp || Date.now(),
          output: undefined,
          exitCode: null,
          autoApproved: false
        };
        const thread = ensureAssistantThread();
        thread.tools.push(item);
        scrollToBottom();
      }
      break;

    case 'toolApprovalResult': {
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      const thread = ensureAssistantThread();
      const existing = thread.tools.find(item => item.type === 'commandApproval' && item.id === msg.approvalId) as CommandApprovalItem | undefined;
      if (existing) {
        existing.status = msg.status || existing.status;
        existing.output = msg.output ?? existing.output;
        existing.autoApproved = !!msg.autoApproved || existing.autoApproved;
        if (typeof msg.command === 'string' && msg.command.trim()) {
          existing.command = msg.command;
        }
        if (typeof msg.exitCode === 'number') {
          existing.exitCode = msg.exitCode;
        }
      } else {
        const item: CommandApprovalItem = {
          id: msg.approvalId || `approval_${Date.now()}`,
          type: 'commandApproval',
          command: msg.command || '',
          cwd: msg.cwd,
          severity: msg.severity || 'medium',
          reason: msg.reason,
          status: msg.status || 'approved',
          timestamp: Date.now(),
          output: msg.output,
          exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null,
          autoApproved: !!msg.autoApproved
        };
        thread.tools.push(item);
      }
      if (currentProgressIndex.value !== null && msg.status && msg.status !== 'pending') {
        const group = thread.tools[currentProgressIndex.value] as ProgressItem;
        group.status = msg.status === 'skipped' ? 'done' : 'done';
        group.actions = group.actions.map(action =>
          action.status === 'running' || action.status === 'pending'
            ? { ...action, status: msg.status === 'skipped' ? 'error' : 'success' }
            : action
        );
        group.lastActionStatus = group.actions[group.actions.length - 1]?.status || 'success';
        group.collapsed = true;
        currentProgressIndex.value = null;
      }
      scrollToBottom();
      break;
    }

    case 'sessionApprovalSettings':
      if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
        autoApproveCommands.value = !!msg.autoApproveCommands;
      }
      break;

    case 'addMessage':
      if (msg.sessionId && currentSessionId.value && msg.sessionId !== currentSessionId.value) {
        break;
      }
      if (msg.message?.role) {
        if (msg.message.role === 'assistant') {
          const thread = ensureAssistantThread(msg.message.model);
          if (thread.tools.length > 0) {
            thread.contentAfter = thread.contentAfter
              ? `${thread.contentAfter}\n\n${msg.message.content}`
              : msg.message.content;
          } else {
            thread.contentBefore = thread.contentBefore
              ? `${thread.contentBefore}\n\n${msg.message.content}`
              : msg.message.content;
          }
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
        }
        scrollToBottom();
      }
      break;

    case 'showThinking':
      if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
        updateThinking(true, msg.message || 'Thinking...');
      }
      break;

    case 'hideThinking':
      if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
        updateThinking(false);
      }
      break;

    case 'startProgressGroup':
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      {
        const thread = ensureAssistantThread();
        const group: ProgressItem = {
          id: `progress_${Date.now()}`,
          type: 'progress',
          title: msg.title || 'Working on task',
          status: 'running',
          collapsed: false,
          actions: [],
          lastActionStatus: undefined
        };
        thread.tools.push(group);
        currentProgressIndex.value = thread.tools.length - 1;
      }
      break;

    case 'showToolAction':
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      {
        const thread = ensureAssistantThread();
        if (currentProgressIndex.value === null) {
          const group: ProgressItem = {
            id: `progress_${Date.now()}`,
            type: 'progress',
            title: 'Working on task',
            status: 'running',
            collapsed: false,
            actions: [],
            lastActionStatus: undefined
          };
          thread.tools.push(group);
          currentProgressIndex.value = thread.tools.length - 1;
        }
        const group = thread.tools[currentProgressIndex.value] as ProgressItem;
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
          const hasActive = group.actions.some(
            actionItem => actionItem.status === 'running' || actionItem.status === 'pending'
          );
          if (!hasActive) {
            group.status = action.status === 'error' ? 'error' : 'done';
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
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      {
        const thread = ensureAssistantThread();
        if (currentProgressIndex.value !== null) {
          const group = thread.tools[currentProgressIndex.value] as ProgressItem;
        group.status = 'done';
        group.collapsed = true;
        group.actions = group.actions.map(action =>
          action.status === 'running' || action.status === 'pending'
            ? { ...action, status: 'success' }
            : action
        );
        const lastAction = group.actions[group.actions.length - 1];
        group.lastActionStatus = lastAction?.status || 'success';
        }
      }
      currentProgressIndex.value = null;
      break;

    case 'streamChunk':
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      if (currentStreamIndex.value === null) {
        startAssistantMessage(msg.model);
      }
      {
        const thread = ensureAssistantThread(msg.model);
        if (thread.tools.length > 0) {
          thread.contentAfter = msg.content || '';
        } else {
          thread.contentBefore = msg.content || '';
        }
        if (msg.model) {
          thread.model = msg.model;
        }
      }
      scrollToBottom();
      break;

    case 'finalMessage':
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      if (currentStreamIndex.value === null) {
        startAssistantMessage(msg.model);
      }
      {
        const thread = ensureAssistantThread(msg.model);
        if (thread.tools.length > 0) {
          thread.contentAfter = msg.content || '';
        } else {
          thread.contentBefore = msg.content || '';
        }
        if (msg.model) {
          thread.model = msg.model;
        }
      }
      currentStreamIndex.value = null;
      scrollToBottom();
      break;

    case 'generationStarted':
      if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
        setGenerating(true);
      }
      break;

    case 'generationStopped':
      if (!msg.sessionId || msg.sessionId === currentSessionId.value) {
        setGenerating(false);
      }
      break;

    case 'addContextItem':
      if (msg.context) {
        contextList.value.push(msg.context);
      }
      break;

    case 'showError':
      if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
        break;
      }
      {
        const thread = ensureAssistantThread();
        if (currentProgressIndex.value === null) {
          const group: ProgressItem = {
            id: `progress_${Date.now()}`,
            type: 'progress',
            title: 'Working on task',
            status: 'running',
            collapsed: false,
            actions: [],
            lastActionStatus: undefined
          };
          thread.tools.push(group);
          currentProgressIndex.value = thread.tools.length - 1;
        }
        const group = thread.tools[currentProgressIndex.value] as ProgressItem;
        const action: ActionItem = {
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
        currentProgressIndex.value = null;
      }
      break;

    case 'clearMessages':
      timeline.value = [];
      currentStreamIndex.value = null;
      currentProgressIndex.value = null;
      if (msg.sessionId) {
        currentSessionId.value = msg.sessionId;
      }
      setGenerating(false);
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
      applySearchResults((msg.results || []) as SearchResultGroup[]);
      break;

    case 'dbMaintenanceResult': {
      const success = !!msg.success;
      const deletedSessions = msg.deletedSessions ?? 0;
      const deletedMessages = msg.deletedMessages ?? 0;
      const message = success
        ? `Maintenance complete. Removed ${deletedSessions} session(s), ${deletedMessages} message(s).`
        : (msg.message || 'Database maintenance failed.');
      showStatus(dbMaintenanceStatus, message, success);
      break;
    }

    case 'recreateMessagesResult': {
      const success = !!msg.success;
      const message = msg.message || (success ? 'Messages table recreated.' : 'Failed to recreate messages table.');
      showStatus(recreateMessagesStatus, message, success);
      break;
    }
  }
});
