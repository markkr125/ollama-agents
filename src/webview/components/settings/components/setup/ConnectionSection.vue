<template>
  <div class="settings-section" :class="{ active: activeSection === 'connection' }">
    <div class="settings-group">
      <h3>Server Connection</h3>
      <div class="settings-item">
        <label class="settings-label">Ollama / OpenWebUI URL</label>
        <input v-model="settings.baseUrl" type="text" @blur="saveBaseUrl" @change="saveBaseUrl" />
      </div>
      <div class="settings-item">
        <label class="settings-label">Bearer Token (OpenWebUI)</label>
        <div class="settings-row">
          <input :type="tokenVisible ? 'text' : 'password'" :value="bearerToken" @input="onBearerInput" />
          <button class="btn btn-secondary" @click="toggleToken">{{ tokenVisible ? '🙈' : '👁' }}</button>
        </div>
        <div class="token-status" :class="{ configured: hasToken }">
          <span class="status-dot"></span>
          <span>{{ hasToken ? 'Token configured' : 'No token configured' }}</span>
        </div>
      </div>
      <div class="setting-actions">
        <button class="btn btn-secondary" @click="testConnection">Test Connection</button>
        <button class="btn btn-primary" @click="saveBearerToken">Save Token</button>
      </div>
      <div class="status-msg" :class="statusClass(connectionStatus)">{{ connectionStatus.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Settings, StatusMessage } from '../../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  settings: Settings;
  saveBaseUrl: () => void;
  tokenVisible: boolean;
  bearerToken: string;
  onBearerInput: (event: Event) => void;
  hasToken: boolean;
  toggleToken: () => void;
  testConnection: () => void;
  saveBearerToken: () => void;
  statusClass: (status: StatusMessage) => Record<string, boolean>;
  connectionStatus: StatusMessage;
}>();
</script>
