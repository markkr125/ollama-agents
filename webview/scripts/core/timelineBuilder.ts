import type {
    ActionItem,
    AssistantThreadItem,
    CommandApprovalItem,
    TimelineItem
} from './types';

export const getProgressTitleForTools = (toolNames: string[]) => {
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

export const buildCommandApprovalItem = (toolMessage: any): CommandApprovalItem | null => {
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

export const buildTimelineFromMessages = (messages: any[]): TimelineItem[] => {
  const items: TimelineItem[] = [];
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

  return items;
};
