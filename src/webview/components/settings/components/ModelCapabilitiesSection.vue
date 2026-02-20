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
              <th class="col-ctx cap-header" title="Context window cap for this model.&#10;'Default' uses the global Agent setting.&#10;Choose a value to override for this model only.">
                <span class="cap-header-label">Context</span>
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
              <td class="col-ctx">
                <select
                  class="ctx-select"
                  :value="model.maxContext ?? 0"
                  :title="contextTitle(model)"
                  @change="onMaxContextChange(model.name, $event)"
                >
                  <option :value="0">Default</option>
                  <option
                    v-for="opt in contextOptions(model)"
                    :key="opt.value"
                    :value="opt.value"
                  >{{ opt.label }}</option>
                </select>
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

      <!-- Context Window -->
      <h3 class="subsection-title">Context Window</h3>
      <p class="section-desc">
        Limit the context window (<code>num_ctx</code>) sent to Ollama.
        Large values allocate more KV cache memory and slow down generation.
      </p>
      <div class="settings-item">
        <label class="settings-label">Default Cap</label>
        <select v-model.number="settings.maxContextWindow" class="settings-select" @change="onDefaultCapChange">
          <option :value="2048">2K</option>
          <option :value="4096">4K</option>
          <option :value="8192">8K</option>
          <option :value="16384">16K</option>
          <option :value="32768">32K</option>
          <option :value="65536">64K (default)</option>
          <option :value="131072">128K</option>
          <option :value="262144">256K</option>
          <option :value="524288">512K</option>
        </select>
        <p class="field-hint">
          Applies to all models unless overridden in the Context column above.
        </p>
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
  updateModelMaxContext: (modelName: string, maxContext: number | null) => void;
  saveMaxContextWindow: () => void;
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

// --- Context window dropdown helpers ---

const CTX_SIZES = [
  { value: 2048, label: '2K' },
  { value: 4096, label: '4K' },
  { value: 8192, label: '8K' },
  { value: 16384, label: '16K' },
  { value: 32768, label: '32K' },
  { value: 65536, label: '64K' },
  { value: 131072, label: '128K' },
  { value: 262144, label: '256K' },
  { value: 524288, label: '512K' },
  { value: 1048576, label: '1M' },
];

function contextOptions(model: ModelInfo) {
  const max = model.contextLength || Infinity;
  return CTX_SIZES.filter(s => s.value <= max);
}

function contextTitle(model: ModelInfo) {
  const detected = model.contextLength ? formatContextK(model.contextLength) : '?';
  const override = model.maxContext ? formatContextK(model.maxContext) : 'Default';
  return `Detected: ${detected}. Override: ${override}`;
}

function formatContextK(tokens: number) {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

function onMaxContextChange(modelName: string, event: Event) {
  const target = event.target as HTMLElement & { value: string };
  const val = Number(target.value);
  props.updateModelMaxContext(modelName, val === 0 ? null : val);
}

function onDefaultCapChange() {
  props.saveMaxContextWindow();
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

.col-ctx {
  width: 80px;
  white-space: nowrap;
}

.ctx-select {
  font-size: 11px;
  padding: 2px 4px;
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, rgba(128,128,128,0.3)));
  border-radius: 3px;
  cursor: pointer;
  width: 100%;
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
