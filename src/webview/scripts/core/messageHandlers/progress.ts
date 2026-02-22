import { scrollToBottom } from '../actions/index';
import { activeThinkingGroup, currentProgressIndex, currentSessionId, progressIndexStack } from '../state';
import type { ActionItem, AssistantThreadThinkingGroupBlock, AssistantThreadToolsBlock, ProgressItem, ShowToolActionMessage, StartProgressGroupMessage, SubagentThinkingMessage } from '../types';
import { closeActiveThinkingGroup } from './streaming';
import { ensureAssistantThread, getOrCreateToolsBlock } from './threadUtils';

/** Detect progress group titles that indicate file-write operations. */
const isWriteGroupTitle = (title: string): boolean =>
  /\b(writ|modif|creat)/i.test(title);

/**
 * Get or create a tools block inside the active thinking group's sections.
 * Reuses the last section if it's already a tools block.
 */
const getOrCreateToolsBlockInGroup = (): AssistantThreadToolsBlock => {
  const group = activeThinkingGroup.value!;
  const lastSection = group.sections[group.sections.length - 1];
  if (lastSection && lastSection.type === 'tools') {
    return lastSection;
  }
  const block: AssistantThreadToolsBlock = { type: 'tools', tools: [] };
  group.sections.push(block);
  return block;
};

/**
 * Resolve the correct tools block: inside the thinking group if active,
 * otherwise at thread level.
 */
const resolveToolsBlock = (): AssistantThreadToolsBlock => {
  if (activeThinkingGroup.value) {
    return getOrCreateToolsBlockInGroup();
  }
  const thread = ensureAssistantThread();
  return getOrCreateToolsBlock(thread);
};

/**
 * Find the last running progress group across ALL tools blocks in the thread —
 * including those buried inside closed thinkingGroup sections.
 *
 * This is critical for sub-agent events: the wrapper group may have been
 * created inside a thinkingGroup's tools section, but by the time
 * showToolAction/finishProgressGroup/subagentThinking arrive, the parent
 * model may have streamed text which closes the thinkingGroup.
 * resolveToolsBlock() then returns the thread-level tools block and can't
 * find the wrapper group.  This helper searches everywhere.
 */
const findLastRunningProgressGroup = (): ProgressItem | null => {
  const thread = ensureAssistantThread();

  // 1. Try current resolveToolsBlock first (fast path)
  const currentBlock = resolveToolsBlock();
  for (let i = currentBlock.tools.length - 1; i >= 0; i--) {
    if (currentBlock.tools[i].type === 'progress' && (currentBlock.tools[i] as ProgressItem).status === 'running') {
      return currentBlock.tools[i] as ProgressItem;
    }
  }

  // 2. Search all thread blocks backwards — check thinkingGroup sections
  for (let b = thread.blocks.length - 1; b >= 0; b--) {
    const block = thread.blocks[b];
    if (block.type === 'thinkingGroup') {
      for (const section of (block as AssistantThreadThinkingGroupBlock).sections) {
        if (section.type === 'tools') {
          for (let i = section.tools.length - 1; i >= 0; i--) {
            if (section.tools[i].type === 'progress' && (section.tools[i] as ProgressItem).status === 'running') {
              return section.tools[i] as ProgressItem;
            }
          }
        }
      }
    } else if (block.type === 'tools') {
      for (let i = (block as AssistantThreadToolsBlock).tools.length - 1; i >= 0; i--) {
        const tool = (block as AssistantThreadToolsBlock).tools[i];
        if (tool.type === 'progress' && (tool as ProgressItem).status === 'running') {
          return tool as ProgressItem;
        }
      }
    }
  }

  return null;
};

export const handleStartProgressGroup = (msg: StartProgressGroupMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();

  // Write actions go at thread level — not buried inside the thinking group
  if (isWriteGroupTitle(msg.title || '') && activeThinkingGroup.value) {
    closeActiveThinkingGroup();
  }

  // Push current group index onto stack so nested sub-agent groups don't clobber parent
  if (currentProgressIndex.value !== null) {
    progressIndexStack.value.push(currentProgressIndex.value);
  }

  const toolsBlock = resolveToolsBlock();
  const group: ProgressItem = {
    id: `progress_${Date.now()}`,
    type: 'progress',
    title: msg.title || 'Working on task',
    detail: msg.detail || undefined,
    status: 'running',
    collapsed: false,
    isSubagent: !!(msg as any).isSubagent,
    actions: [],
    lastActionStatus: undefined
  };
  toolsBlock.tools.push(group);
  currentProgressIndex.value = toolsBlock.tools.length - 1;
};

export const handleShowToolAction = (msg: ShowToolActionMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();
  const toolsBlock = resolveToolsBlock();

  // Find last progress group — first in current tools block, then across all
  // thread blocks (handles case where group lives inside a closed thinkingGroup)
  let group: ProgressItem | null = null;
  for (let i = toolsBlock.tools.length - 1; i >= 0; i--) {
    if (toolsBlock.tools[i].type === 'progress') {
      group = toolsBlock.tools[i] as ProgressItem;
      currentProgressIndex.value = i;
      break;
    }
  }

  // Fallback: search thinkingGroup sections for a running group
  if (!group) {
    group = findLastRunningProgressGroup();
  }

  if (!group) {
    group = {
      id: `progress_${Date.now()}`,
      type: 'progress',
      title: 'Working on task',
      status: 'running',
      collapsed: false,
      actions: [],
      lastActionStatus: undefined
    };
    toolsBlock.tools.push(group);
    currentProgressIndex.value = toolsBlock.tools.length - 1;
  }

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
  const action: ActionItem = {
    id: `action_${Date.now()}_${Math.random()}`,
    status: msg.status || 'running',
    icon: msg.icon || '•',
    text: actionText,
    detail: msg.detail || null,
    ...(msg.filePath ? { filePath: msg.filePath } : {}),
    ...(msg.checkpointId ? { checkpointId: msg.checkpointId } : {}),
    ...(msg.startLine != null ? { startLine: msg.startLine } : {})
  };
  if (action.status !== 'running' && action.status !== 'pending') {
    // Final state (success/error) - update existing or push
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
  } else if (existingIndex >= 0) {
    // Running/pending with same text as existing - update in place
    group.actions[existingIndex] = { ...group.actions[existingIndex], ...action };
    group.status = 'running';
  } else {
    // New running/pending action - push
    group.actions.push(action);
    group.status = 'running';
  }
  group.lastActionStatus = action.status;
  scrollToBottom();
};

export const handleFinishProgressGroup = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();

  // Resolve the tools block that should contain the group being finished.
  // IMPORTANT: when a thinkingGroup was active at startProgressGroup time but
  // has since been closed (e.g. by streamChunk text), resolveToolsBlock() now
  // returns the thread-level tools block — a DIFFERENT container.  Walk both
  // the current tools block AND all thinkingGroup sections to find the group.
  const toolsBlock = resolveToolsBlock();
  let group: ProgressItem | null = null;

  if (currentProgressIndex.value !== null) {
    const candidate = toolsBlock.tools[currentProgressIndex.value];
    if (candidate && candidate.type === 'progress') {
      group = candidate as ProgressItem;
    }
  }

  // Fallback: search current toolsBlock backwards for the last progress group
  if (!group) {
    for (let i = toolsBlock.tools.length - 1; i >= 0; i--) {
      if (toolsBlock.tools[i].type === 'progress' && (toolsBlock.tools[i] as ProgressItem).status === 'running') {
        group = toolsBlock.tools[i] as ProgressItem;
        break;
      }
    }
  }

  // Fallback: search thinkingGroup sections (group may live inside a closed thinking group)
  if (!group) {
    const thread = ensureAssistantThread();
    for (let b = thread.blocks.length - 1; b >= 0; b--) {
      const block = thread.blocks[b];
      if (block.type === 'thinkingGroup') {
        for (const section of (block as any).sections) {
          if (section.type === 'tools') {
            for (let i = section.tools.length - 1; i >= 0; i--) {
              if (section.tools[i].type === 'progress' && (section.tools[i] as ProgressItem).status === 'running') {
                group = section.tools[i] as ProgressItem;
                break;
              }
            }
          }
          if (group) break;
        }
      }
      if (group) break;
    }
  }

  if (group) {
    const hasError = group.actions.some(action => action.status === 'error');
    group.status = hasError ? 'error' : 'done';
    // Sub-agent groups stay expanded so thinking content remains visible
    group.collapsed = !group.isSubagent;
    // Mutate actions in place to preserve Vue reactivity on deeply nested arrays
    for (let i = 0; i < group.actions.length; i++) {
      if (group.actions[i].status === 'running' || group.actions[i].status === 'pending') {
        group.actions[i] = { ...group.actions[i], status: 'success' };
      }
    }
    const lastAction = group.actions[group.actions.length - 1];
    group.lastActionStatus = lastAction?.status || 'success';
  }
  // Restore parent group index from the stack (supports nested sub-agent groups)
  currentProgressIndex.value = progressIndexStack.value.pop() ?? null;
};

export const handleShowError = (msg: any) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();
  const toolsBlock = resolveToolsBlock();
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
    toolsBlock.tools.push(group);
    currentProgressIndex.value = toolsBlock.tools.length - 1;
  }
  const group = toolsBlock.tools[currentProgressIndex.value] as ProgressItem;
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
  currentProgressIndex.value = progressIndexStack.value.pop() ?? null;
};

/**
 * Handle sub-agent thinking content. Inserts thinking as an ordered
 * ActionItem in the progress group so it renders inline with tool actions
 * (before/after them depending on when it arrived).
 */
export const handleSubagentThinking = (msg: SubagentThinkingMessage) => {
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) {
    return;
  }
  ensureAssistantThread();

  // Find the last progress group — search current tools block first,
  // then fall back to searching all blocks (handles closed thinkingGroups)
  const toolsBlock = resolveToolsBlock();
  let group: ProgressItem | null = null;
  for (let i = toolsBlock.tools.length - 1; i >= 0; i--) {
    if (toolsBlock.tools[i].type === 'progress') {
      group = toolsBlock.tools[i] as ProgressItem;
      break;
    }
  }
  if (!group) {
    group = findLastRunningProgressGroup();
  }

  if (group) {
    // Push as an ordered action item — renders inline at this position
    group.actions.push({
      id: `thinking_${Date.now()}_${Math.random()}`,
      status: 'success',
      icon: '💭',
      text: msg.durationSeconds ? `Thought for ${msg.durationSeconds}s` : 'Thought',
      detail: null,
      isThinking: true,
      thinkingContent: msg.content || '',
      durationSeconds: msg.durationSeconds
    });
  }
};
