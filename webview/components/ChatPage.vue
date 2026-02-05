<template>
  <div class="page" :class="{ active: currentPage === 'chat' }">
    <div v-if="currentMode === 'agent'" class="chat-toolbar">
      <div class="chat-toolbar-title">Session controls</div>
      <div
        class="chat-toolbar-item"
        title="Auto-approve commands for this session (critical commands still require approval)"
      >
        <span class="chat-toolbar-label">Auto-approve commands</span>
        <div class="toggle" :class="{ on: autoApproveCommands }" @click="toggleAutoApproveCommands"></div>
      </div>
      <div
        class="chat-toolbar-item"
        title="Auto-approve sensitive file edits for this session"
      >
        <span class="chat-toolbar-label">Auto-approve sensitive edits</span>
        <div class="toggle" :class="{ on: autoApproveSensitiveEdits }" @click="toggleAutoApproveSensitiveEdits"></div>
      </div>
    </div>
    <div
      v-if="currentMode === 'agent' && autoApproveConfirmVisible"
      class="auto-approve-confirm-overlay"
      @click.self="cancelAutoApproveCommands"
    >
      <div class="auto-approve-confirm-dialog">
        <div class="confirm-dialog-icon">⚠️</div>
        <div class="confirm-dialog-title">Enable Auto-Approve Commands?</div>
        <div class="confirm-dialog-message">
          Commands will run automatically without asking for approval.
          <strong>This can be risky</strong> as it allows the agent to execute terminal commands without your review.
          <br><br>
          Critical commands (like <code>rm -rf</code>, <code>sudo</code>) will still require approval.
        </div>
        <div class="confirm-dialog-actions">
          <button class="approve-btn" @click="confirmAutoApproveCommands">Enable Auto-Approve</button>
          <button class="skip-btn" @click="cancelAutoApproveCommands">Cancel</button>
        </div>
      </div>
    </div>
    <div class="messages" ref="localMessagesEl">
      <div v-if="timeline.length === 0" class="empty-state">
        <h3>How can I help you today?</h3>
        <p>Ask me to write code, explain concepts, or help with your project.</p>
      </div>

      <template v-for="(item, index) in timeline" :key="item.id">
        <template v-if="item.type === 'assistantThread'">
          <div
            class="message"
            :class="item.role === 'user' ? 'message-user' : 'message-assistant'"
            :id="`message-${item.id}`"
            :data-message-id="item.id"
          >
            <template v-for="(block, bIndex) in item.blocks" :key="`${item.id}-${bIndex}`">
              <div v-if="block.type === 'text'" class="markdown-body" v-html="formatMarkdown(block.content)"></div>

              <div v-else class="assistant-tools">
                <template v-for="toolItem in block.tools" :key="toolItem.id">
                  <template v-if="toolItem.type === 'commandApproval'">
                    <CommandApproval
                      :item="toolItem"
                      :on-approve="handleApproveCommand"
                      :on-skip="handleSkipCommand"
                      :auto-approve-enabled="autoApproveCommands"
                      :on-toggle-auto-approve="toggleAutoApproveCommands"
                    />
                  </template>

                  <template v-else-if="toolItem.type === 'fileEditApproval'">
                    <FileEditApproval
                      :item="toolItem"
                      :on-approve="handleApproveFileEdit"
                      :on-skip="handleSkipFileEdit"
                      :on-open-diff="handleOpenFileDiff"
                      :auto-approve-enabled="autoApproveSensitiveEdits"
                      :on-toggle-auto-approve="toggleAutoApproveSensitiveEdits"
                    />
                  </template>

                  <div v-else-if="toolItem.type === 'progress'" class="progress-group" :class="{ collapsed: toolItem.collapsed }">
                    <div class="progress-header" @click="toggleProgress(toolItem)">
                      <span class="progress-chevron">▼</span>
                      <span class="progress-status" :class="progressStatusClass(toolItem)">
                        <span v-if="progressStatus(toolItem) === 'running'" class="spinner"></span>
                        <span v-else-if="progressStatus(toolItem) === 'success'">✓</span>
                        <span v-else-if="progressStatus(toolItem) === 'error'">✗</span>
                        <span v-else>○</span>
                      </span>
                      <span class="progress-title">{{ toolItem.title }}</span>
                    </div>
                    <div class="progress-actions">
                      <div class="action-item" v-for="action in toolItem.actions" :key="action.id">
                        <span class="action-status" :class="actionStatusClass(action.status)">
                          <span v-if="action.status === 'running'" class="spinner"></span>
                          <span v-else-if="action.status === 'success'">✓</span>
                          <span v-else-if="action.status === 'error'">✗</span>
                          <span v-else>○</span>
                        </span>
                        <span class="file-icon">{{ action.icon }}</span>
                        <span class="action-text">
                          <span class="filename">{{ action.text }}</span>
                          <span v-if="action.detail" class="detail">, {{ action.detail }}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </template>
            <div v-if="item.model" class="message-model">{{ item.model }}</div>
          </div>
          <div
            v-if="index < timeline.length - 1"
            class="message-divider"
          ></div>
        </template>

        <template v-else-if="item.type === 'message'">
          <div
            class="message"
            :class="item.role === 'user' ? 'message-user' : 'message-assistant'"
            :id="`message-${item.id}`"
            :data-message-id="item.id"
          >
            <div v-if="item.role === 'assistant'" class="markdown-body" v-html="formatMarkdown(item.content)"></div>
            <div v-else class="message-text">{{ item.content }}</div>
            <div v-if="item.role === 'assistant' && item.model" class="message-model">{{ item.model }}</div>
          </div>
          <div
            v-if="item.role === 'assistant' && index < timeline.length - 1"
            class="message-divider"
          ></div>
        </template>

        <template v-else-if="item.type === 'commandApproval'">
          <CommandApproval
            :item="item"
            :on-approve="handleApproveCommand"
            :on-skip="handleSkipCommand"
            :auto-approve-enabled="autoApproveCommands"
            :on-toggle-auto-approve="toggleAutoApproveCommands"
          />
        </template>

        <template v-else-if="item.type === 'fileEditApproval'">
          <FileEditApproval
            :item="item"
            :on-approve="handleApproveFileEdit"
            :on-skip="handleSkipFileEdit"
            :on-open-diff="handleOpenFileDiff"
            :auto-approve-enabled="autoApproveSensitiveEdits"
            :on-toggle-auto-approve="toggleAutoApproveSensitiveEdits"
          />
        </template>

        <div v-else class="progress-group" :class="{ collapsed: item.collapsed }">
          <div class="progress-header" @click="toggleProgress(item)">
            <span class="progress-chevron">▼</span>
            <span class="progress-status" :class="progressStatusClass(item)">
              <span v-if="progressStatus(item) === 'running'" class="spinner"></span>
              <span v-else-if="progressStatus(item) === 'success'">✓</span>
              <span v-else-if="progressStatus(item) === 'error'">✗</span>
              <span v-else>○</span>
            </span>
            <span class="progress-title">{{ item.title }}</span>
          </div>
          <div class="progress-actions">
            <div class="action-item" v-for="action in item.actions" :key="action.id">
              <span class="action-status" :class="actionStatusClass(action.status)">
                <span v-if="action.status === 'running'" class="spinner"></span>
                <span v-else-if="action.status === 'success'">✓</span>
                <span v-else-if="action.status === 'error'">✗</span>
                <span v-else>○</span>
              </span>
              <span class="file-icon">{{ action.icon }}</span>
              <span class="action-text">
                <span class="filename">{{ action.text }}</span>
                <span v-if="action.detail" class="detail">, {{ action.detail }}</span>
              </span>
            </div>
          </div>
        </div>
      </template>

      <div class="thinking" :class="{ visible: thinking.visible }">
        <div class="spinner"></div>
        <span>{{ thinking.text }}</span>
      </div>
    </div>

    <div class="input-container">
      <div class="context-chips" :class="{ visible: contextList.length > 0 }">
        <div class="context-chip" v-for="(c, i) in contextList" :key="c.fileName + i">
          <span>📄 {{ c.fileName }}</span>
          <span class="context-chip-remove" @click="removeContext(i)">×</span>
        </div>
      </div>

      <div class="input-box">
        <textarea
          ref="localInputEl"
          :value="inputText"
          placeholder="Describe what to build next"
          rows="1"
          @input="onInputText"
          @keydown.enter.exact.prevent="handleEnter"
        ></textarea>
        <div class="input-controls">
          <div class="input-controls-left">
            <button class="icon-btn" title="Add context" @click="addContext">📎</button>
            <select :value="currentMode" @change="onModeChange">
              <option value="agent">Agent</option>
              <option value="plan">Plan</option>
              <option value="ask">Ask</option>
              <option value="edit">Edit</option>
            </select>
            <select :value="currentModel" @change="onModelChange">
              <option v-if="modelOptions.length === 0" value="">Loading...</option>
              <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <button class="send-btn" @click="handleSend">{{ isGenerating ? 'Stop' : 'Send' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ActionItem, CommandApprovalItem, FileEditApprovalItem, ProgressItem, TimelineItem } from '../scripts/core/types';
import CommandApproval from './CommandApproval.vue';
import FileEditApproval from './FileEditApproval.vue';

type ThinkingState = {
  visible: boolean;
  text: string;
};

type ContextItem = {
  fileName: string;
  content: string;
};

const props = defineProps({
  currentPage: {
    type: String as PropType<'chat' | 'settings' | 'sessions'>,
    required: true
  },
  setMessagesEl: {
    type: Function as PropType<(value: HTMLDivElement | null) => void>,
    required: true
  },
  setInputEl: {
    type: Function as PropType<(value: HTMLTextAreaElement | null) => void>,
    required: true
  },
  timeline: {
    type: Array as PropType<TimelineItem[]>,
    required: true
  },
  thinking: {
    type: Object as PropType<ThinkingState>,
    required: true
  },
  contextList: {
    type: Array as PropType<ContextItem[]>,
    required: true
  },
  inputText: {
    type: String,
    required: true
  },
  setInputText: {
    type: Function as PropType<(value: string) => void>,
    required: true
  },
  currentMode: {
    type: String,
    required: true
  },
  setCurrentMode: {
    type: Function as PropType<(value: string) => void>,
    required: true
  },
  currentModel: {
    type: String,
    required: true
  },
  setCurrentModel: {
    type: Function as PropType<(value: string) => void>,
    required: true
  },
  modelOptions: {
    type: Array as PropType<string[]>,
    required: true
  },
  autoApproveCommands: {
    type: Boolean,
    required: true
  },
  autoApproveConfirmVisible: {
    type: Boolean,
    required: true
  },
  toggleAutoApproveCommands: {
    type: Function as PropType<() => void>,
    required: true
  },
  confirmAutoApproveCommands: {
    type: Function as PropType<() => void>,
    required: true
  },
  cancelAutoApproveCommands: {
    type: Function as PropType<() => void>,
    required: true
  },
  approveCommand: {
    type: Function as PropType<(approvalId: string, command: string) => void>,
    required: true
  },
  skipCommand: {
    type: Function as PropType<(approvalId: string) => void>,
    required: true
  },
  approveFileEdit: {
    type: Function as PropType<(approvalId: string) => void>,
    required: true
  },
  skipFileEdit: {
    type: Function as PropType<(approvalId: string) => void>,
    required: true
  },
  openFileDiff: {
    type: Function as PropType<(approvalId: string) => void>,
    required: true
  },
  autoApproveSensitiveEdits: {
    type: Boolean,
    required: true
  },
  toggleAutoApproveSensitiveEdits: {
    type: Function as PropType<() => void>,
    required: true
  },
  isGenerating: {
    type: Boolean,
    required: true
  },
  formatMarkdown: {
    type: Function as PropType<(text: string) => string>,
    required: true
  },
  toggleProgress: {
    type: Function as PropType<(item: ProgressItem) => void>,
    required: true
  },
  actionStatusClass: {
    type: Function as PropType<(status: ActionItem['status']) => Record<string, boolean>>,
    required: true
  },
  addContext: {
    type: Function as PropType<() => void>,
    required: true
  },
  removeContext: {
    type: Function as PropType<(index: number) => void>,
    required: true
  },
  handleEnter: {
    type: Function as PropType<() => void>,
    required: true
  },
  handleSend: {
    type: Function as PropType<() => void>,
    required: true
  },
  resizeInput: {
    type: Function as PropType<() => void>,
    required: true
  },
  selectMode: {
    type: Function as PropType<() => void>,
    required: true
  },
  selectModel: {
    type: Function as PropType<() => void>,
    required: true
  },
  scrollTargetMessageId: {
    type: String as PropType<string | null>,
    default: null
  },
  clearScrollTarget: {
    type: Function as PropType<() => void>,
    required: true
  }
});

const localMessagesEl = ref<HTMLDivElement | null>(null);
const localInputEl = ref<HTMLTextAreaElement | null>(null);

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
    item.status = 'approved';
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
  props.setInputEl(localInputEl.value);
  if (localMessagesEl.value) {
    localMessagesEl.value.addEventListener('click', onMessagesClick);
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
  }
});

const onInputText = (event: Event) => {
  const value = (event.target as HTMLTextAreaElement).value;
  props.setInputText(value);
  props.resizeInput();
};

const onModeChange = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value;
  props.setCurrentMode(value);
  props.selectMode();
};

const onModelChange = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value;
  props.setCurrentModel(value);
  props.selectModel();
};
</script>
