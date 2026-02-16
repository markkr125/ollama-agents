<template>
  <div class="settings-section" :class="{ active: activeSection === 'models' }">
    <div class="settings-group">
      <h3>Model Selection</h3>
      <div class="settings-item">
        <label class="settings-label">Agent Model</label>
        <select v-model="settings.agentModel">
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="settings-item">
        <label class="settings-label">Chat Model</label>
        <select v-model="settings.chatModel">
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="settings-item">
        <label class="settings-label">Completion Model</label>
        <select v-model="settings.completionModel">
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <button class="btn btn-primary" @click="saveModelSettings">Save Model Settings</button>
      <div class="status-msg" :class="statusClass(modelsStatus)">{{ modelsStatus.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Settings, StatusMessage } from '../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  settings: Settings;
  modelOptions: string[];
  saveModelSettings: () => void;
  statusClass: (status: StatusMessage) => Record<string, boolean>;
  modelsStatus: StatusMessage;
}>();
</script>
