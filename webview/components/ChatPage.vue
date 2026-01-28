<template>
  <div class="page" :class="{ active: currentPage === 'chat' }">
    <div class="messages" ref="localMessagesEl">
      <div v-if="timeline.length === 0" class="empty-state">
        <h3>How can I help you today?</h3>
        <p>Ask me to write code, explain concepts, or help with your project.</p>
      </div>

      <template v-for="item in timeline" :key="item.id">
        <div v-if="item.type === 'message'" class="message" :class="item.role === 'user' ? 'message-user' : 'message-assistant'">
          <div v-if="item.role === 'assistant'" v-html="formatMarkdown(item.content)"></div>
          <div v-else>{{ item.content }}</div>
        </div>

        <div v-else class="progress-group" :class="{ collapsed: item.collapsed }">
          <div class="progress-header" @click="toggleProgress(item)">
            <span class="progress-chevron">▼</span>
            <span class="progress-status" :class="{ done: item.status === 'done' }">
              <span v-if="item.status === 'running'" class="spinner"></span>
              <span v-else-if="item.status === 'done'">✓</span>
              <span v-else-if="item.status === 'error'">✗</span>
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
    </div>

    <div class="thinking" :class="{ visible: thinking.visible }">
      <div class="spinner"></div>
      <span>{{ thinking.text }}</span>
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
import { onMounted, ref } from 'vue';
import type { ActionItem, ProgressItem, TimelineItem } from '../scripts/core/types';

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
    type: String as PropType<'chat' | 'settings'>,
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
  }
});

const localMessagesEl = ref<HTMLDivElement | null>(null);
const localInputEl = ref<HTMLTextAreaElement | null>(null);

onMounted(() => {
  props.setMessagesEl(localMessagesEl.value);
  props.setInputEl(localInputEl.value);
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
