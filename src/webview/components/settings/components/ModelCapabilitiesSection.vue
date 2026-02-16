<template>
  <div class="settings-section" :class="{ active: activeSection === 'models' }">
    <div class="settings-group">
      <h3>Models</h3>
      <p class="section-desc">
        Manage your downloaded models. Toggle models on/off, assign them to modes, and view capabilities
        detected via the Ollama <code>/api/show</code> endpoint.
      </p>

      <!-- Progress bar (only visible during capability check) -->
      <div v-if="capabilityCheckProgress.running" class="capability-progress">
        <div class="progress-label">
          Checking capabilities… {{ capabilityCheckProgress.completed }}/{{ capabilityCheckProgress.total }}
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
      </div>

      <div v-if="modelInfo.length === 0 && !capabilityCheckProgress.running" class="empty-state">
        <p>No models available. Connect to Ollama to see your models here.</p>
      </div>

      <div v-else class="capabilities-table-wrapper">
        <table class="capabilities-table">
          <thead>
            <tr>
              <th class="col-toggle cap-header" title="Enable or disable a model.&#10;Disabled models won't appear in the model selection dropdowns.">
                <span class="cap-header-label">On</span>
              </th>
              <th class="col-name">Model</th>
              <th class="col-size">Size</th>
              <th class="col-quant cap-header" title="Quantization level — affects model size vs quality trade-off.&#10;Lower quant (Q4) = smaller, faster, less accurate.&#10;Higher quant (Q8, FP16) = larger, slower, more accurate.">
                <span class="cap-header-label">Quant</span>
              </th>
              <th class="col-cap cap-header" title="Conversational chat — model has a chat template and can hold multi-turn conversations.&#10;Models without chat are typically embedding or raw completion models.">
                <span class="cap-header-label">Chat</span>
              </th>
              <th class="col-cap cap-header" title="Image understanding — models that can process and describe images">
                <span class="cap-header-label">Vision</span>
              </th>
              <th class="col-cap cap-header" title="Fill-in-Middle — required for inline code completions">
                <span class="cap-header-label">FIM</span>
              </th>
              <th class="col-cap cap-header" title="Function/tool calling — required for agent mode">
                <span class="cap-header-label">Tools</span>
              </th>
              <th class="col-cap cap-header" title="Embedding model — generates vector embeddings for text.&#10;These models cannot chat or generate text, only produce numerical representations.">
                <span class="cap-header-label">Embed</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in modelInfo" :key="model.name" :class="{ 'row-disabled': !model.enabled }">
              <td class="col-toggle">
                <input
                  type="checkbox"
                  :checked="model.enabled"
                  :title="model.enabled ? 'Disable this model' : 'Enable this model'"
                  @change="toggleModelEnabled(model.name, !model.enabled)"
                />
              </td>
              <td class="col-name" :title="model.name">{{ model.name }}</td>
              <td class="col-size">
                {{ formatSize(model.size) }}
              </td>
              <td class="col-quant">{{ model.quantizationLevel || '—' }}</td>
              <td class="col-cap">
                <span :class="model.capabilities.chat ? 'cap-yes' : 'cap-no'">{{ model.capabilities.chat ? '✓' : '✗' }}</span>
              </td>
              <td class="col-cap">
                <span :class="model.capabilities.vision ? 'cap-yes' : 'cap-no'">{{ model.capabilities.vision ? '✓' : '✗' }}</span>
              </td>
              <td class="col-cap">
                <span :class="model.capabilities.fim ? 'cap-yes' : 'cap-no'">{{ model.capabilities.fim ? '✓' : '✗' }}</span>
              </td>
              <td class="col-cap">
                <span :class="model.capabilities.tools ? 'cap-yes' : 'cap-no'">{{ model.capabilities.tools ? '✓' : '✗' }}</span>
              </td>
              <td class="col-cap">
                <span :class="model.capabilities.embedding ? 'cap-yes' : 'cap-no'">{{ model.capabilities.embedding ? '✓' : '✗' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="table-actions">
        <button
          class="btn btn-secondary refresh-btn"
          :disabled="capabilityCheckProgress.running"
          @click="refreshCapabilities"
        >
          {{ capabilityCheckProgress.running ? 'Checking…' : '↻ Refresh All' }}
        </button>
        <button class="btn btn-secondary" :disabled="allEnabled" @click="enableAll">Enable All</button>
        <button class="btn btn-secondary" :disabled="noneEnabled" @click="disableAll">Disable All</button>
      </div>

      <!-- Model Selection -->
      <h3 class="subsection-title">Model Selection</h3>
      <p class="section-desc">
        Choose which model to use for each mode. Only enabled models appear here.
        Changes are saved automatically.
      </p>
      <div class="settings-item">
        <label class="settings-label">Agent Model</label>
        <select v-model="settings.agentModel" @change="autoSave">
          <option v-if="modelOptions.length === 0" value="" disabled>No enabled models</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="settings-item">
        <label class="settings-label">Chat Model</label>
        <select v-model="settings.chatModel" @change="autoSave">
          <option v-if="modelOptions.length === 0" value="" disabled>No enabled models</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="settings-item">
        <label class="settings-label">Completion Model</label>
        <select v-model="settings.completionModel" @change="autoSave">
          <option v-if="fimModelOptions.length === 0" value="" disabled>No FIM-capable models</option>
          <option v-for="m in fimModelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
        <p class="field-hint">Only models with Fill-in-Middle (FIM) support are shown.</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { CapabilityCheckProgress, Settings } from '../../../scripts/core/settings';
import type { ModelInfo } from '../../../scripts/core/types';

const props = defineProps<{
  activeSection: string;
  modelInfo: ModelInfo[];
  capabilityCheckProgress: CapabilityCheckProgress;
  refreshCapabilities: () => void;
  toggleModelEnabled: (modelName: string, enabled: boolean) => void;
  settings: Settings;
  modelOptions: string[];
  saveModelSettings: () => void;
}>();

const progressPercent = computed(() => {
  if (props.capabilityCheckProgress.total === 0) return 0;
  return Math.round((props.capabilityCheckProgress.completed / props.capabilityCheckProgress.total) * 100);
});

const fimModelOptions = computed(() => {
  const fimNames = new Set(
    props.modelInfo
      .filter(m => m.enabled && m.capabilities.fim)
      .map(m => m.name)
  );
  return props.modelOptions.filter(name => fimNames.has(name));
});

const allEnabled = computed(() => props.modelInfo.length > 0 && props.modelInfo.every(m => m.enabled));
const noneEnabled = computed(() => props.modelInfo.length > 0 && props.modelInfo.every(m => !m.enabled));

function enableAll() {
  for (const m of props.modelInfo) {
    if (!m.enabled) props.toggleModelEnabled(m.name, true);
  }
}

function disableAll() {
  for (const m of props.modelInfo) {
    if (m.enabled) props.toggleModelEnabled(m.name, false);
  }
}

function autoSave() {
  props.saveModelSettings();
}

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
</script>

<style scoped>
.section-desc {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  margin-bottom: 12px;
}

.empty-state {
  color: var(--vscode-descriptionForeground);
  text-align: center;
  padding: 24px 0;
}

.capabilities-table-wrapper {
  overflow-x: auto;
}

.capabilities-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.capabilities-table th,
.capabilities-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
}

.capabilities-table th {
  font-weight: 600;
  color: var(--vscode-foreground);
  white-space: nowrap;
  position: sticky;
  top: 0;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

.capabilities-table tbody tr:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
}

.row-disabled {
  opacity: 0.45;
}

.col-toggle {
  width: 32px;
  text-align: center !important;
}

.col-toggle input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--vscode-progressBar-background, #0078d4);
}

.col-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-size {
  white-space: nowrap;
  color: var(--vscode-descriptionForeground);
}

.col-quant {
  white-space: nowrap;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.col-cap {
  text-align: center !important;
  width: 52px;
}

.cap-header {
  cursor: help;
  transition: color 0.15s ease;
}

.cap-header:hover {
  color: var(--vscode-errorForeground, #f14c4c);
}

.cap-header:hover .cap-header-label {
  text-decoration: underline;
  text-decoration-style: dotted;
}

.cap-yes {
  color: var(--vscode-testing-iconPassed, #73c991);
  font-weight: 600;
}

.cap-no {
  color: var(--vscode-descriptionForeground);
  opacity: 0.5;
}

/* Progress bar */
.capability-progress {
  margin-bottom: 12px;
}

.progress-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}

.progress-bar-track {
  height: 4px;
  background: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--vscode-progressBar-background, #0078d4);
  border-radius: 2px;
  transition: width 0.2s ease;
}

/* Table action buttons row */
.table-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.table-actions .btn {
  font-size: 12px;
}

.field-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
  opacity: 0.85;
}

/* Model selection sub-section */
.subsection-title {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
}
</style>
