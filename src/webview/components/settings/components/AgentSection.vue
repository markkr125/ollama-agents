<template>
  <div class="settings-section" :class="{ active: activeSection === 'agent' }">
    <div class="settings-group">
      <h3>Agent Settings</h3>
      <div class="settings-item">
        <label class="settings-label">Max Iterations</label>
        <input v-model.number="settings.maxIterations" type="number" />
      </div>
      <div class="settings-item">
        <label class="settings-label">Max Active Sessions</label>
        <input v-model.number="settings.maxActiveSessions" type="number" min="1" max="5" />
      </div>
      <div class="settings-item">
        <label class="settings-label">Tool Timeout (seconds)</label>
        <input type="number" :value="toolTimeoutSeconds" @input="onToolTimeoutInput" />
      </div>
      <div class="settings-item">
        <label class="settings-label">Sensitive File Patterns (JSON)</label>
        <textarea
          v-model="settings.sensitiveFilePatterns"
          class="settings-textarea"
          rows="8"
          spellcheck="false"
        ></textarea>
        <div class="settings-desc">
          Use glob patterns with true = auto-approve, false = require approval.
        </div>
      </div>
      <div class="settings-item">
        <label class="settings-label">Session Override Patterns</label>
        <textarea
          class="settings-textarea"
          rows="4"
          :value="localSessionPatterns"
          spellcheck="false"
          placeholder="{&quot;**/*&quot;: true, &quot;**/.env*&quot;: false}"
          @input="$emit('update:localSessionPatterns', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
        <div class="settings-desc">
          Override sensitive file patterns for the current session only.
        </div>
        <button class="btn btn-secondary" style="margin-top: 8px" @click="saveSessionPatterns">Save Session Override</button>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Enable Thinking</span>
          <span class="toggle-desc">Show model's chain-of-thought reasoning (requires model support)</span>
        </div>
        <div class="toggle" :class="{ on: settings.enableThinking }" @click="settings.enableThinking = !settings.enableThinking"></div>
      </div>
      <div class="settings-item">
        <label class="settings-label">Continuation Strategy</label>
        <select v-model="settings.continuationStrategy" class="settings-select">
          <option value="full">Full — Session memory + rich context (best quality)</option>
          <option value="standard">Standard — Tool results only (balanced)</option>
          <option value="minimal">Minimal — Single-pass with auto-fix retry (fastest)</option>
        </select>
        <div class="settings-desc">
          Controls how the agent continues between iterations. Full uses more tokens but produces better results.
        </div>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Auto Create Git Branch</span>
          <span class="toggle-desc">Create a new branch for agent tasks</span>
        </div>
        <div class="toggle" :class="{ on: agentSettings.autoCreateBranch }" @click="agentSettings.autoCreateBranch = !agentSettings.autoCreateBranch"></div>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">Auto Commit</span>
          <span class="toggle-desc">Automatically commit changes</span>
        </div>
        <div class="toggle" :class="{ on: agentSettings.autoCommit }" @click="agentSettings.autoCommit = !agentSettings.autoCommit"></div>
      </div>
      <button class="btn btn-primary" @click="saveAgentSettings">Save Agent Settings</button>
      <div class="status-msg" :class="statusClass(agentStatus)">{{ agentStatus.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AgentSettings, Settings, StatusMessage } from '../../../scripts/core/settings';

defineProps<{
  activeSection: string;
  settings: Settings;
  toolTimeoutSeconds: number;
  onToolTimeoutInput: (event: Event) => void;
  localSessionPatterns: string;
  saveSessionPatterns: () => void;
  agentSettings: AgentSettings;
  saveAgentSettings: () => void;
  statusClass: (status: StatusMessage) => Record<string, boolean>;
  agentStatus: StatusMessage;
}>();

defineEmits<{
  'update:localSessionPatterns': [value: string];
}>();
</script>
