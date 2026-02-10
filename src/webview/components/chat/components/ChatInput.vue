<template>
  <div class="input-container">
    <div class="context-chips" :class="{ visible: contextList.length > 0 }">
      <div v-for="(c, i) in contextList" :key="c.fileName + i" class="context-chip">
        <span>📄 {{ c.fileName }}</span>
        <span class="context-chip-remove" @click="removeContext(i)">×</span>
      </div>
    </div>

    <div class="input-box">
      <textarea
        ref="inputEl"
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
            <option v-if="modelOptions.length === 0" value="" disabled>No enabled models</option>
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <button class="send-btn" @click="handleSend">{{ isGenerating ? 'Stop' : 'Send' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ContextItem } from '../../../scripts/core/chat';

const props = defineProps<{
  contextList: ContextItem[];
  inputText: string;
  currentMode: string;
  currentModel: string;
  modelOptions: string[];
  isGenerating: boolean;
  onInputText: (event: Event) => void;
  onModeChange: (event: Event) => void;
  onModelChange: (event: Event) => void;
  addContext: () => void;
  removeContext: (index: number) => void;
  handleEnter: () => void;
  handleSend: () => void;
  setInputEl: (value: HTMLTextAreaElement | null) => void;
}>();

const inputEl = ref<HTMLTextAreaElement | null>(null);

onMounted(() => {
  props.setInputEl(inputEl.value);
});
</script>
