import { recalcBlockTotals } from './messageHandlers/filesChanged';
import { filesChangedBlocks } from './state';
import type {
  AssistantThreadFilesChangedBlock,
  AssistantThreadItem,
  AssistantThreadToolsBlock,
  CommandApprovalItem,
  FileEditApprovalItem,
  ProgressItem,
  TimelineItem
} from './types';

/**
 * SIMPLE timeline builder: iterate messages in timestamp order, render each one.
 * No fancy grouping. No restructuring. Just replay exactly as stored.
 */
export const buildTimelineFromMessages = (messages: any[]): TimelineItem[] => {
  const items: TimelineItem[] = [];
  const restoredFcBlocks: AssistantThreadFilesChangedBlock[] = [];
  let currentThread: AssistantThreadItem | null = null;
  let currentGroup: ProgressItem | null = null;

  // Helper: get or create current assistant thread
  const ensureThread = (model?: string): AssistantThreadItem => {
    if (!currentThread) {
      currentThread = {
        id: `thread_${Date.now()}_${Math.random()}`,
        type: 'assistantThread',
        role: 'assistant',
        // Start with empty text block to match live handler behavior
        blocks: [{ type: 'text', content: '' }],
        model
      };
      items.push(currentThread);
    }
    if (model) currentThread.model = model;
    return currentThread;
  };

  // Helper: get or create a tools block at the end of current thread
  const ensureToolsBlock = (): AssistantThreadToolsBlock => {
    const thread = ensureThread();
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    if (lastBlock && lastBlock.type === 'tools') {
      return lastBlock;
    }
    const newBlock: AssistantThreadToolsBlock = { type: 'tools', tools: [] };
    thread.blocks.push(newBlock);
    return newBlock;
  };

  // Helper: append text to current thread
  const appendText = (content: string, model?: string) => {
    if (!content) return;
    const thread = ensureThread(model);

    // Only append to existing text block if it's the LAST block in thread.
    // If tools/thinking blocks have been added since, create a new text block.
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    if (lastBlock && lastBlock.type === 'text') {
      lastBlock.content = lastBlock.content ? `${lastBlock.content}\n\n${content}` : content;
    } else {
      thread.blocks.push({ type: 'text', content });
    }
  };

  // Process each message in order (already sorted by timestamp from backend)
  for (const m of messages) {
    // USER MESSAGE: new timeline item, reset thread
    if (m.role === 'user') {
      items.push({
        id: m.id || `msg_${Date.now()}_${Math.random()}`,
        type: 'message',
        role: 'user',
        content: m.content || '',
        model: m.model
      });
      currentThread = null;
      currentGroup = null;
      continue;
    }

    // ASSISTANT MESSAGE: append to current thread
    if (m.role === 'assistant') {
      appendText(m.content || '', m.model);
      continue;
    }

    // TOOL MESSAGE: handle based on toolName
    if (m.role === 'tool') {
      const toolName = m.toolName;

      // __ui__ events: replay exactly as stored
      if (toolName === '__ui__') {
        let uiEvent: any = null;
        try {
          uiEvent = JSON.parse(m.toolOutput || m.content || '{}');
        } catch {
          continue;
        }
        if (!uiEvent?.eventType) continue;

        // thinkingBlock is a thread-level block, not a tool item — handle before ensureToolsBlock
        if (uiEvent.eventType === 'thinkingBlock') {
          const thread = ensureThread();
          thread.blocks.push({
            type: 'thinking',
            content: uiEvent.payload?.content || '',
            collapsed: true
          });
          continue;
        }

        const toolsBlock = ensureToolsBlock();

        switch (uiEvent.eventType) {
          case 'startProgressGroup': {
            currentGroup = {
              id: uiEvent.payload?.groupId || `progress_${m.id}`,
              type: 'progress',
              title: uiEvent.payload?.title || 'Working on task',
              status: 'running',
              collapsed: false,
              actions: []
            };
            toolsBlock.tools.push(currentGroup);
            break;
          }
          case 'showToolAction': {
            if (!currentGroup) {
              // Create implicit group if none exists
              currentGroup = {
                id: `progress_${m.id}`,
                type: 'progress',
                title: 'Working on task',
                status: 'running',
                collapsed: false,
                actions: []
              };
              toolsBlock.tools.push(currentGroup);
            }
            const status = uiEvent.payload?.status || 'running';
            const actionText = uiEvent.payload?.text || 'Tool';
            const action = {
              id: `action_${m.id}`,
              status,
              icon: uiEvent.payload?.icon || '•',
              text: actionText,
              detail: uiEvent.payload?.detail || null,
              filePath: uiEvent.payload?.filePath || undefined,
              checkpointId: uiEvent.payload?.checkpointId || undefined
            };

            // Match live handler: update existing pending/running action with same text, or push new
            if (status !== 'running' && status !== 'pending') {
              // Final state (success/error) - update existing or push
              const existingIndex = currentGroup.actions.findIndex(
                a => (a.status === 'running' || a.status === 'pending') && a.text === actionText
              );
              if (existingIndex >= 0) {
                currentGroup.actions[existingIndex] = { ...currentGroup.actions[existingIndex], ...action };
              } else {
                // Try to find last running/pending action to update
                const lastPendingIndex = [...currentGroup.actions].reverse().findIndex(
                  a => a.status === 'running' || a.status === 'pending'
                );
                if (lastPendingIndex >= 0) {
                  const resolvedIndex = currentGroup.actions.length - 1 - lastPendingIndex;
                  currentGroup.actions[resolvedIndex] = { ...currentGroup.actions[resolvedIndex], ...action };
                } else {
                  currentGroup.actions.push(action);
                }
              }
            } else {
              // Running/pending state - check if same text exists, update; otherwise push
              const existingIndex = currentGroup.actions.findIndex(
                a => (a.status === 'running' || a.status === 'pending') && a.text === actionText
              );
              if (existingIndex >= 0) {
                currentGroup.actions[existingIndex] = { ...currentGroup.actions[existingIndex], ...action };
              } else {
                currentGroup.actions.push(action);
              }
            }

            if (status === 'error') currentGroup.status = 'error';
            break;
          }
          case 'finishProgressGroup': {
            if (currentGroup) {
              // Convert remaining pending/running actions to success (matching live handler)
              currentGroup.actions = currentGroup.actions.map(action =>
                action.status === 'running' || action.status === 'pending'
                  ? { ...action, status: 'success' as const }
                  : action
              );
              currentGroup.status = currentGroup.actions.some(a => a.status === 'error') ? 'error' : 'done';
              currentGroup.collapsed = true;
              currentGroup = null;
            }
            break;
          }
          case 'requestToolApproval': {
            // Add action to current progress group for pending approval
            if (currentGroup) {
              currentGroup.actions.push({
                id: `action_${uiEvent.payload?.id || m.id}`,
                status: 'running',
                icon: '⚡',
                text: 'Run command',
                detail: 'Awaiting approval'
              });
            }
            // Also add the approval card
            toolsBlock.tools.push({
              id: uiEvent.payload?.id || `approval_${m.id}`,
              type: 'commandApproval',
              command: uiEvent.payload?.command || '',
              cwd: uiEvent.payload?.cwd || '',
              severity: uiEvent.payload?.severity || 'medium',
              reason: uiEvent.payload?.reason,
              status: 'pending',
              timestamp: uiEvent.payload?.timestamp || Date.now(),
              output: undefined,
              exitCode: null,
              autoApproved: false
            } as CommandApprovalItem);
            break;
          }
          case 'toolApprovalResult': {
            // Update action in progress group to show final status
            if (currentGroup) {
              const actionId = `action_${uiEvent.payload?.approvalId}`;
              const existingAction = currentGroup.actions.find(a => a.id === actionId);
              if (existingAction) {
                const isError = uiEvent.payload?.status === 'skipped' || uiEvent.payload?.status === 'error';
                existingAction.status = isError ? 'error' : 'success';
                existingAction.detail = uiEvent.payload?.command?.substring(0, 60) || existingAction.detail;
                if (isError) currentGroup.status = 'error';
              }
            }
            // Find and update the existing approval card
            const approvalId = uiEvent.payload?.approvalId;
            let found = false;
            for (const block of ensureThread().blocks) {
              if (block.type === 'tools') {
                const existing = block.tools.find(
                  item => item.type === 'commandApproval' && item.id === approvalId
                ) as CommandApprovalItem | undefined;
                if (existing) {
                  existing.status = uiEvent.payload?.status || existing.status;
                  existing.output = uiEvent.payload?.output ?? existing.output;
                  existing.exitCode = uiEvent.payload?.exitCode ?? existing.exitCode;
                  if (uiEvent.payload?.command) existing.command = uiEvent.payload.command;
                  found = true;
                  break;
                }
              }
            }
            // If not found, add as new approval
            if (!found) {
              const tb = ensureToolsBlock();
              tb.tools.push({
                id: approvalId || `approval_${m.id}`,
                type: 'commandApproval',
                command: uiEvent.payload?.command || '',
                cwd: uiEvent.payload?.cwd || '',
                severity: uiEvent.payload?.severity || 'medium',
                reason: uiEvent.payload?.reason,
                status: uiEvent.payload?.status || 'approved',
                timestamp: Date.now(),
                output: uiEvent.payload?.output,
                exitCode: uiEvent.payload?.exitCode ?? null,
                autoApproved: !!uiEvent.payload?.autoApproved
              } as CommandApprovalItem);
            }
            break;
          }
          case 'requestFileEditApproval': {
            // Only add the file edit approval card - actions are handled by showToolAction events
            toolsBlock.tools.push({
              id: uiEvent.payload?.id || `file_approval_${m.id}`,
              type: 'fileEditApproval',
              filePath: uiEvent.payload?.filePath || '',
              severity: uiEvent.payload?.severity || 'medium',
              reason: uiEvent.payload?.reason,
              status: 'pending',
              timestamp: uiEvent.payload?.timestamp || Date.now(),
              diffHtml: uiEvent.payload?.diffHtml,
              autoApproved: false
            } as FileEditApprovalItem);
            break;
          }
          case 'fileEditApprovalResult': {
            // Find and update the existing file edit approval card
            const approvalId = uiEvent.payload?.approvalId;
            let found = false;
            for (const block of ensureThread().blocks) {
              if (block.type === 'tools') {
                const existing = block.tools.find(
                  item => item.type === 'fileEditApproval' && item.id === approvalId
                ) as FileEditApprovalItem | undefined;
                if (existing) {
                  existing.status = uiEvent.payload?.status || existing.status;
                  existing.autoApproved = !!uiEvent.payload?.autoApproved;
                  found = true;
                  break;
                }
              }
            }
            // If not found (e.g., auto-approved), add as new approval with final status
            if (!found) {
              const tb = ensureToolsBlock();
              tb.tools.push({
                id: approvalId || `file_approval_${m.id}`,
                type: 'fileEditApproval',
                filePath: uiEvent.payload?.filePath || '',
                severity: uiEvent.payload?.severity || 'medium',
                reason: uiEvent.payload?.reason,
                status: uiEvent.payload?.status || 'approved',
                timestamp: Date.now(),
                diffHtml: uiEvent.payload?.diffHtml,
                autoApproved: !!uiEvent.payload?.autoApproved
              } as FileEditApprovalItem);
            }
            break;
          }
          case 'showError': {
            // Reconstruct error action in progress group (matches live handleShowError)
            if (!currentGroup) {
              currentGroup = {
                id: `progress_${m.id}`,
                type: 'progress',
                title: 'Working on task',
                status: 'running',
                collapsed: false,
                actions: []
              };
              const tb = ensureToolsBlock();
              tb.tools.push(currentGroup);
            }
            currentGroup.actions.push({
              id: `action_${m.id}`,
              status: 'error',
              icon: '✗',
              text: uiEvent.payload?.message || 'Error',
              detail: null
            });
            currentGroup.status = 'error';
            currentGroup.collapsed = true;
            currentGroup = null;
            break;
          }
          case 'filesChanged': {
            const payload = uiEvent.payload || {};
            const checkpointId = payload.checkpointId || '';
            const isPending = !payload.status || payload.status === 'pending';

            // Merge into existing block with same checkpointId (matches live handler)
            const existing = checkpointId
              ? restoredFcBlocks.find(b => b.checkpointId === checkpointId)
              : null;

            if (existing) {
              // Add any files not already in the block
              for (const f of payload.files || []) {
                if (!existing.files.some((ef: any) => ef.path === f.path)) {
                  existing.files.push({
                    path: f.path,
                    action: f.action || 'modified',
                    additions: undefined,
                    deletions: undefined,
                    status: 'pending' as const
                  });
                }
              }
            } else {
              const block: AssistantThreadFilesChangedBlock = {
                type: 'filesChanged',
                checkpointId,
                files: (payload.files || []).map((f: any) => ({
                  path: f.path,
                  action: f.action || 'modified',
                  additions: undefined,
                  deletions: undefined,
                  status: payload.status === 'kept' ? 'kept' as const
                    : payload.status === 'undone' ? 'undone' as const
                    : 'pending' as const
                })),
                totalAdditions: undefined,
                totalDeletions: undefined,
                status: payload.status || 'pending',
                collapsed: !isPending,
                statsLoading: isPending
              };
              restoredFcBlocks.push(block);
            }
            break;
          }
          case 'fileChangeResult': {
            // Remove a resolved file from an existing filesChanged block
            const payload = uiEvent.payload || {};
            if (payload.success && payload.checkpointId) {
              const fcBlock = restoredFcBlocks.find(b => b.checkpointId === payload.checkpointId);
              if (fcBlock) {
                const idx = fcBlock.files.findIndex((f: any) => f.path === payload.filePath);
                if (idx >= 0) {
                  fcBlock.files.splice(idx, 1);
                }
                // If no files left, remove the block entirely
                if (fcBlock.files.length === 0) {
                  const blockIdx = restoredFcBlocks.indexOf(fcBlock);
                  if (blockIdx >= 0) restoredFcBlocks.splice(blockIdx, 1);
                } else {
                  recalcBlockTotals(fcBlock);
                }
              }
            }
            break;
          }
          case 'keepUndoResult': {
            // Keep All / Undo All resolves every file — remove ALL blocks for this checkpoint
            const payload = uiEvent.payload || {};
            if (payload.success && payload.checkpointId) {
              for (let i = restoredFcBlocks.length - 1; i >= 0; i--) {
                if (restoredFcBlocks[i].checkpointId === payload.checkpointId) {
                  restoredFcBlocks.splice(i, 1);
                }
              }
            }
            break;
          }
          default:
            break;
        }
        continue;
      }

      // Legacy tool messages (non-__ui__): just skip them if we have UI events
      // They're only here for backwards compatibility with old sessions
    }
  }

  // Push restored filesChanged blocks to the standalone state
  filesChangedBlocks.value = restoredFcBlocks;

  return items;
};