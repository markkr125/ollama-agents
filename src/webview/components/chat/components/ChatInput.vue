<template>
  <div class="input-container">
    <div class="input-box">
      <!-- Attached context area (inside the input box, above textarea) -->
      <div class="attached-context">
        <!-- Implicit selection chip -->
        <div
          v-if="implicitSelection"
          class="context-chip implicit selection"
          title="Active selection"
        >
          <span class="codicon codicon-selection"></span>
          <span class="chip-name">{{ selectionChipLabel }}</span>
          <span
            class="codicon codicon-pinned chip-action"
            title="Pin to context"
            @click.stop="pinSelection"
          ></span>
        </div>

        <!-- Explicit context chips -->
        <div v-for="(c, i) in contextList" :key="c.fileName + i" class="context-chip explicit">
          <span class="file-icon" :style="{ color: fileIconColor(c.fileName) }">{{ fileIconChar(c.fileName) }}</span>
          <span class="chip-name">{{ chipDisplayName(c.fileName) }}</span>
          <span class="codicon codicon-close chip-action" @click="removeContext(i)"></span>
        </div>

        <!-- Implicit file chip (pending — shown at end) -->
        <div
          v-if="showImplicitFile"
          class="context-chip implicit"
          :class="{ disabled: isAgentMode }"
          :title="isAgentMode ? 'Click to add as context' : 'Current file context'"
          @click="onImplicitFileClick"
        >
          <span class="file-icon" :style="{ color: fileIconColor(implicitFile?.fileName ?? '') }">{{ fileIconChar(implicitFile?.fileName ?? '') }}</span>
          <span class="chip-name">{{ implicitFile?.fileName }}</span>
          <span
            v-if="isAgentMode"
            class="codicon codicon-plus chip-action"
            title="Add to context"
          ></span>
          <span
            v-else
            class="codicon chip-action"
            :class="implicitFileEnabled ? 'codicon-eye' : 'codicon-eye-closed'"
            title="Toggle file context"
            @click.stop="toggleImplicitFile"
          ></span>
        </div>

        <!-- Attach button -->
        <div ref="attachBtnEl" class="attach-trigger">
          <button class="icon-btn attach-btn" title="Add context" @click="toggleAttachMenu">
            <span class="codicon codicon-attach"></span>
          </button>
          <DropdownMenu
            v-if="attachMenuOpen"
            :items="attachMenuItems"
            :anchor-rect="attachMenuRect"
            @select="onAttachSelect"
            @close="attachMenuOpen = false"
          />
        </div>
      </div>

      <!-- Textarea -->
      <textarea
        ref="inputEl"
        :value="inputText"
        placeholder="Describe what to build next"
        rows="1"
        @input="onInputText"
        @keydown.enter.exact.prevent="handleEnter"
      ></textarea>

      <!-- Bottom toolbar -->
      <div class="input-toolbar">
        <div class="toolbar-left">
          <PillPicker
            :items="modeItems"
            :model-value="currentMode"
            :icon="currentModeIcon"
            @update:model-value="onModeChange"
          />
          <PillPicker
            :items="modelDropdownItems"
            :model-value="currentModel"
            icon="codicon-server"
            placeholder="Select model"
            @update:model-value="onModelChange"
          />
          <button
            v-if="currentMode === 'agent'"
            class="icon-btn tools-btn"
            :class="{ active: toolsActive }"
            title="Agent settings"
            @click="$emit('toggleTools')"
          >
            <span class="codicon codicon-tools"></span>
          </button>
        </div>
        <div class="toolbar-right">
          <button class="send-btn" :title="isGenerating ? 'Stop' : 'Send'" @click="handleSend">
            <span class="codicon" :class="isGenerating ? 'codicon-debug-stop' : 'codicon-send'"></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ContextItem } from '../../../scripts/core/chat';
import { fileIconChar, fileIconColor } from '../../../scripts/core/fileIcons';
import type { DropdownItem } from './DropdownMenu.vue';
import DropdownMenu from './DropdownMenu.vue';
import PillPicker from './PillPicker.vue';

const props = defineProps<{
  contextList: ContextItem[];
  inputText: string;
  currentMode: string;
  currentModel: string;
  modelOptions: string[];
  isGenerating: boolean;
  implicitFile: { fileName: string; filePath: string; relativePath: string; languageId: string } | null;
  implicitSelection: { fileName: string; relativePath: string; content: string; startLine: number; endLine: number; languageId: string } | null;
  implicitFileEnabled: boolean;
  toolsActive: boolean;
  onInputText: (event: Event) => void;
  onModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  addContext: () => void;
  addContextFromFile: () => void;
  addContextCurrentFile: () => void;
  addContextFromTerminal: () => void;
  removeContext: (index: number) => void;
  handleEnter: () => void;
  handleSend: () => void;
  setInputEl: (value: HTMLTextAreaElement | null) => void;
  toggleImplicitFile: () => void;
  promoteImplicitFile: () => void;
  pinSelection: () => void;
}>();

defineEmits<{
  (e: 'toggleTools'): void;
}>();

const inputEl = ref<HTMLTextAreaElement | null>(null);
const attachBtnEl = ref<HTMLElement | null>(null);
const attachMenuOpen = ref(false);
const attachMenuRect = ref({ top: 0, left: 0, bottom: 0, width: 0 });

const isAgentMode = computed(() => props.currentMode === 'agent');

/** Extract basename from a possibly-relative path for chip display, preserving line range. */
function chipDisplayName(name: string): string {
  const colonIdx = name.indexOf(':L');
  const pathPart = colonIdx >= 0 ? name.substring(0, colonIdx) : name;
  const rangePart = colonIdx >= 0 ? name.substring(colonIdx) : '';
  const parts = pathPart.split('/');
  return (parts[parts.length - 1] || pathPart) + rangePart;
}

// Mode picker items
const modeItems = computed<DropdownItem[]>(() => [
  { id: 'agent', icon: 'codicon-hubot', label: 'Agent', description: 'Autonomous coding agent' },
  { id: 'plan', icon: 'codicon-list-tree', label: 'Plan', description: 'Multi-step implementation plan' },
  { id: 'ask', icon: 'codicon-comment-discussion', label: 'Ask', description: 'Ask questions about code' },
  { id: 'edit', icon: 'codicon-edit', label: 'Edit', description: 'Apply edits to selected code' },
]);

const currentModeIcon = computed(() => {
  const item = modeItems.value.find(i => i.id === props.currentMode);
  return item?.icon ?? 'codicon-hubot';
});

// Model picker items
const modelDropdownItems = computed<DropdownItem[]>(() =>
  props.modelOptions.map(m => ({
    id: m,
    icon: 'codicon-server',
    label: m,
  }))
);

// Attach menu items
const attachMenuItems = computed<DropdownItem[]>(() => [
  { id: 'file', icon: 'codicon-file-add', label: 'Add File...', description: 'Browse workspace files' },
  { id: 'selection', icon: 'codicon-selection', label: 'Active Selection', description: 'Current editor selection' },
  { id: 'currentFile', icon: 'codicon-file-code', label: 'Current File', description: 'Entire active file' },
  { id: 'separator', icon: '', label: '', separator: true },
  { id: 'terminal', icon: 'codicon-terminal', label: 'Terminal Output', description: 'Recent terminal output' },
]);

// Whether the implicit file chip should show (not if same file already in explicit context)
const showImplicitFile = computed(() => {
  if (!props.implicitFile) return false;
  return !props.contextList.some(c => c.fileName === props.implicitFile?.fileName);
});

const selectionChipLabel = computed(() => {
  if (!props.implicitSelection) return '';
  const { fileName, startLine, endLine } = props.implicitSelection;
  return `${fileName}:L${startLine}-L${endLine}`;
});

const onImplicitFileClick = () => {
  if (isAgentMode.value) {
    props.promoteImplicitFile();
  }
};

const pinSelection = () => {
  props.pinSelection();
};

const toggleAttachMenu = () => {
  if (attachMenuOpen.value) {
    attachMenuOpen.value = false;
    return;
  }
  if (attachBtnEl.value) {
    const rect = attachBtnEl.value.getBoundingClientRect();
    attachMenuRect.value = {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      width: rect.width
    };
  }
  attachMenuOpen.value = true;
};

const onAttachSelect = (id: string) => {
  attachMenuOpen.value = false;
  switch (id) {
    case 'file':
      props.addContextFromFile();
      break;
    case 'selection':
      props.addContext();
      break;
    case 'currentFile':
      props.addContextCurrentFile();
      break;
    case 'terminal':
      props.addContextFromTerminal();
      break;
  }
};

onMounted(() => {
  props.setInputEl(inputEl.value);
});
</script>
