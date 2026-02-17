import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { autoScrollLocked } from '../state';
import type { CommandApprovalItem, FileEditApprovalItem, ProgressItem } from '../types';
import type { ChatPageProps } from './types';

/** Threshold in pixels — user is "near bottom" if within this distance. */
const SCROLL_BOTTOM_THRESHOLD = 50;

export function useChatPage(props: ChatPageProps) {
  const localMessagesEl = ref<HTMLDivElement | null>(null);
  const sessionControlsExpanded = ref(false);

  const progressStatus = (item: ProgressItem) => {
    if (item.status === 'error') return 'error';
    if (item.status === 'done') return 'success';
    if (item.status === 'running') return 'running';
    const hasRunning = item.actions.some(action => action.status === 'running' || action.status === 'pending');
    if (hasRunning) return 'running';
    if (item.actions.some(action => action.status === 'error')) return 'error';
    if (item.lastActionStatus) return item.lastActionStatus;
    return 'running';
  };

  const progressStatusClass = (item: ProgressItem) => {
    const status = progressStatus(item);
    return {
      done: status === 'success',
      running: status === 'running',
      error: status === 'error',
      pending: status === 'pending'
    };
  };

  const copyText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  };

  const findCommandApprovalItem = (approvalId: string) => {
    for (const entry of props.timeline) {
      if (entry.type === 'commandApproval' && entry.id === approvalId) {
        return entry as CommandApprovalItem;
      }
      if (entry.type === 'assistantThread') {
        for (const block of entry.blocks) {
          if (block.type !== 'tools') continue;
          const match = block.tools.find(
            tool => tool.type === 'commandApproval' && tool.id === approvalId
          ) as CommandApprovalItem | undefined;
          if (match) return match;
        }
      }
    }
    return undefined;
  };

  const handleApproveCommand = (approvalId: string, command: string) => {
    const item = findCommandApprovalItem(approvalId);
    if (item) {
      item.status = 'running';
      item.command = command;
    }
    props.approveCommand(approvalId, command);
  };

  const handleSkipCommand = (approvalId: string) => {
    const item = findCommandApprovalItem(approvalId);
    if (item) {
      item.status = 'skipped';
    }
    props.skipCommand(approvalId);
  };

  const findFileEditApprovalItem = (approvalId: string) => {
    for (const entry of props.timeline) {
      if (entry.type === 'fileEditApproval' && entry.id === approvalId) {
        return entry as FileEditApprovalItem;
      }
      if (entry.type === 'assistantThread') {
        for (const block of entry.blocks) {
          if (block.type !== 'tools') continue;
          const match = block.tools.find(
            tool => tool.type === 'fileEditApproval' && tool.id === approvalId
          ) as FileEditApprovalItem | undefined;
          if (match) return match;
        }
      }
    }
    return undefined;
  };

  const handleApproveFileEdit = (approvalId: string) => {
    const item = findFileEditApprovalItem(approvalId);
    if (item) {
      item.status = 'approved';
    }
    props.approveFileEdit(approvalId);
  };

  const handleSkipFileEdit = (approvalId: string) => {
    const item = findFileEditApprovalItem(approvalId);
    if (item) {
      item.status = 'skipped';
    }
    props.skipFileEdit(approvalId);
  };

  const handleOpenFileDiff = (approvalId: string) => {
    props.openFileDiff(approvalId);
  };

  /**
   * Sticky-scroll: detect whether the user is near the bottom of the messages
   * container. If they scroll away, lock auto-scroll so streaming doesn't yank
   * them back. If they scroll back to the bottom, unlock.
   */
  const onMessagesScroll = () => {
    const el = localMessagesEl.value;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_BOTTOM_THRESHOLD;
    autoScrollLocked.value = !nearBottom;
  };

  const onMessagesClick = async (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const button = target.closest('.code-copy-btn') as HTMLButtonElement | null;
    if (!button) return;

    const block = button.closest('.code-block');
    const codeElement = block?.querySelector('code');
    const codeText = codeElement?.textContent ?? '';
    if (!codeText) return;

    try {
      await copyText(codeText);
      const defaultLabel = button.getAttribute('data-copy-label') || 'Copy';
      const copiedLabel = button.getAttribute('data-copied-label') || 'Copied';

      const existingTimeout = button.dataset.copyTimeoutId;
      if (existingTimeout) {
        clearTimeout(Number(existingTimeout));
      }

      button.textContent = copiedLabel;
      button.classList.add('copied');
      const timeoutId = window.setTimeout(() => {
        button.textContent = defaultLabel;
        button.classList.remove('copied');
        delete button.dataset.copyTimeoutId;
      }, 2000);
      button.dataset.copyTimeoutId = String(timeoutId);
    } catch {
      // ignore copy errors
    }
  };

  onMounted(() => {
    props.setMessagesEl(localMessagesEl.value);
    if (localMessagesEl.value) {
      localMessagesEl.value.addEventListener('click', onMessagesClick);
      localMessagesEl.value.addEventListener('scroll', onMessagesScroll, { passive: true });
    }
  });

  // Watch for scroll target changes (when clicking search results)
  watch(
    () => props.scrollTargetMessageId,
    async (messageId) => {
      if (!messageId) return;

      // Wait for DOM updates
      await nextTick();
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));

      const container = localMessagesEl.value;
      if (!container) return;

      const targetId = `message-${messageId}`;
      const safeSelector = typeof CSS !== 'undefined' && CSS.escape ? `#${CSS.escape(targetId)}` : null;
      const messageEl = safeSelector
        ? (container.querySelector(safeSelector) as HTMLElement | null)
        : (container.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null);
      if (messageEl) {
        const paddingOffset = 0;
        const targetTop = messageEl.offsetTop - container.offsetTop - paddingOffset;
        container.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });

        // Add highlight effect
        messageEl.classList.add('highlight-flash');
        setTimeout(() => {
          messageEl.classList.remove('highlight-flash');
        }, 2000);
      }

      // Clear the scroll target after handling
      props.clearScrollTarget();
    }
  );

  onBeforeUnmount(() => {
    if (localMessagesEl.value) {
      localMessagesEl.value.removeEventListener('click', onMessagesClick);
      localMessagesEl.value.removeEventListener('scroll', onMessagesScroll);
    }
  });

  const onInputText = (event: Event) => {
    const value = (event.target as HTMLTextAreaElement).value;
    props.setInputText(value);
    props.resizeInput();
  };

  const onModeChange = (value: string) => {
    props.setCurrentMode(value);
    props.selectMode();
  };

  const onModelChange = (value: string) => {
    props.setCurrentModel(value);
    props.selectModel();
  };

  return {
    localMessagesEl,
    sessionControlsExpanded,
    progressStatus,
    progressStatusClass,
    handleApproveCommand,
    handleSkipCommand,
    handleApproveFileEdit,
    handleSkipFileEdit,
    handleOpenFileDiff,
    onInputText,
    onModeChange,
    onModelChange,
  };
}
