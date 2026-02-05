<template>
  <div class="page" :class="{ active: currentPage === 'settings' }">
    <div class="settings-container">
      <div class="settings-nav">
        <div class="settings-nav-item" :class="{ active: activeSection === 'connection' }" @click="setActiveSection('connection')">Connection</div>
        <div class="settings-nav-item" :class="{ active: activeSection === 'models' }" @click="setActiveSection('models')">Models</div>
        <div class="settings-nav-item" :class="{ active: activeSection === 'chat' }" @click="setActiveSection('chat')">Chat</div>
        <div class="settings-nav-item" :class="{ active: activeSection === 'autocomplete' }" @click="setActiveSection('autocomplete')">Autocomplete</div>
        <div class="settings-nav-item" :class="{ active: activeSection === 'agent' }" @click="setActiveSection('agent')">Agent</div>
        <div class="settings-nav-item" :class="{ active: activeSection === 'tools' }" @click="setActiveSection('tools')">Tools</div>
        <div class="settings-nav-item" :class="{ active: activeSection === 'advanced' }" @click="setActiveSection('advanced')">Advanced</div>
      </div>

      <div class="settings-content">
        <!-- Connection Section -->
        <div class="settings-section" :class="{ active: activeSection === 'connection' }">
          <div class="settings-group">
            <h3>Server Connection</h3>
            <div class="settings-item">
              <label class="settings-label">Ollama / OpenWebUI URL</label>
              <input type="text" v-model="settings.baseUrl" @blur="saveBaseUrl" @change="saveBaseUrl" />
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

        <!-- Models Section -->
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
              <label class="settings-label">Ask Model</label>
              <select v-model="settings.askModel">
                <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="settings-item">
              <label class="settings-label">Edit Model</label>
              <select v-model="settings.editModel">
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

        <!-- Chat Section -->
        <div class="settings-section" :class="{ active: activeSection === 'chat' }">
          <div class="settings-group">
            <h3>Chat Settings</h3>
            <div class="toggle-row">
              <div class="toggle-info">
                <span class="toggle-label">Stream Responses</span>
                <span class="toggle-desc">Show responses as they are generated</span>
              </div>
              <div class="toggle" :class="{ on: chatSettings.streamResponses }" @click="chatSettings.streamResponses = !chatSettings.streamResponses"></div>
            </div>
            <div class="toggle-row">
              <div class="toggle-info">
                <span class="toggle-label">Show Tool Actions</span>
                <span class="toggle-desc">Display agent tool actions in chat</span>
              </div>
              <div class="toggle" :class="{ on: chatSettings.showToolActions }" @click="chatSettings.showToolActions = !chatSettings.showToolActions"></div>
            </div>
            <div class="settings-item">
              <label class="settings-label">Temperature</label>
              <div class="slider-row">
                <input type="range" min="0" max="100" :value="temperatureSlider" @input="onTemperatureInput" />
                <span>{{ temperatureDisplay }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Autocomplete Section -->
        <div class="settings-section" :class="{ active: activeSection === 'autocomplete' }">
          <div class="settings-group">
            <h3>Autocomplete Settings</h3>
            <div class="toggle-row">
              <div class="toggle-info">
                <span class="toggle-label">Enable Autocomplete</span>
                <span class="toggle-desc">Provide inline code suggestions</span>
              </div>
              <div class="toggle" :class="{ on: settings.enableAutoComplete }" @click="toggleAutocomplete"></div>
            </div>
            <div class="toggle-row">
              <div class="toggle-info">
                <span class="toggle-label">Auto Trigger</span>
                <span class="toggle-desc">Trigger suggestions automatically</span>
              </div>
              <div class="toggle" :class="{ on: autocomplete.autoTrigger }" @click="autocomplete.autoTrigger = !autocomplete.autoTrigger"></div>
            </div>
            <div class="settings-item">
              <label class="settings-label">Trigger Delay (ms)</label>
              <input type="number" v-model.number="autocomplete.triggerDelay" />
            </div>
            <div class="settings-item">
              <label class="settings-label">Max Tokens</label>
              <input type="number" v-model.number="autocomplete.maxTokens" />
            </div>
          </div>
        </div>

        <!-- Agent Section -->
        <div class="settings-section" :class="{ active: activeSection === 'agent' }">
          <div class="settings-group">
            <h3>Agent Settings</h3>
            <div class="settings-item">
              <label class="settings-label">Max Iterations</label>
              <input type="number" v-model.number="settings.maxIterations" />
            </div>
            <div class="settings-item">
              <label class="settings-label">Max Active Sessions</label>
              <input type="number" min="1" max="5" v-model.number="settings.maxActiveSessions" />
            </div>
                <div class="settings-item">
                  <label class="settings-label">Tool Timeout (seconds)</label>
                  <input type="number" :value="toolTimeoutSeconds" @input="onToolTimeoutInput" />
                </div>
            <div class="settings-item">
              <label class="settings-label">Sensitive File Patterns (JSON)</label>
              <textarea
                class="settings-textarea"
                rows="8"
                v-model="settings.sensitiveFilePatterns"
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
                v-model="localSessionPatterns"
                spellcheck="false"
                placeholder='{"**/*": true, "**/.env*": false}'
              ></textarea>
              <div class="settings-desc">
                Override sensitive file patterns for the current session only.
              </div>
              <button class="btn btn-secondary" style="margin-top: 8px" @click="saveSessionPatterns">Save Session Override</button>
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

        <!-- Tools Section -->
        <div class="settings-section" :class="{ active: activeSection === 'tools' }">
          <div class="settings-group">
            <h3>Available Tools</h3>
            <div class="tools-grid">
              <div class="tool-card" v-for="tool in tools" :key="tool.name">
                <div class="tool-header">
                  <span class="tool-icon">{{ tool.icon }}</span>
                  <span class="tool-name">{{ tool.name }}</span>
                </div>
                <p class="tool-desc">{{ tool.desc }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Advanced Section -->
        <div class="settings-section" :class="{ active: activeSection === 'advanced' }">
          <div class="settings-group">
            <h3>DB Maintenance</h3>
            <div class="settings-item">
              <label class="settings-label">Sync Sessions</label>
              <div class="settings-desc">
                Ensures sessions deleted from SQLite are removed from LanceDB messages and vice versa.
              </div>
            </div>
            <button class="btn btn-primary" @click="runDbMaintenance">Run DB Maintenance</button>
            <div class="status-msg" :class="statusClass(dbMaintenanceStatus)">{{ dbMaintenanceStatus.message }}</div>
          </div>

          <div class="settings-group danger-zone">
            <h3>⚠️ Danger Zone</h3>
            <div class="settings-item">
              <label class="settings-label">Recreate Messages Table</label>
              <div class="settings-desc danger-desc">
                Completely deletes and recreates the messages table. Use this to fix schema errors like "Found field not in schema".
                <strong>WARNING: This will permanently delete all chat history!</strong>
              </div>
            </div>
            <button class="btn btn-danger" @click="confirmRecreateMessagesTable">Recreate Messages Table</button>
            <div class="status-msg" :class="statusClass(recreateMessagesStatus)">{{ recreateMessagesStatus.message }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { ref, watch } from 'vue';
import { updateSessionSensitivePatterns } from '../scripts/core/actions/index';
import { sessionSensitiveFilePatterns } from '../scripts/core/state';

type StatusMessage = {
  visible: boolean;
  success: boolean;
  message: string;
};

type Settings = {
  baseUrl: string;
  enableAutoComplete: boolean;
  agentModel: string;
  askModel: string;
  editModel: string;
  completionModel: string;
  maxIterations: number;
  toolTimeout: number;
  maxActiveSessions: number;
  temperature: number;
  sensitiveFilePatterns: string;
};

type ChatSettings = {
  streamResponses: boolean;
  showToolActions: boolean;
};

type AutocompleteSettings = {
  autoTrigger: boolean;
  triggerDelay: number;
  maxTokens: number;
};

type AgentSettings = {
  autoCreateBranch: boolean;
  autoCommit: boolean;
};

type ToolItem = {
  name: string;
  icon: string;
  desc: string;
};

const props = defineProps({
  currentPage: {
    type: String as PropType<'chat' | 'settings' | 'sessions'>,
    required: true
  },
  activeSection: {
    type: String,
    required: true
  },
  setActiveSection: {
    type: Function as PropType<(section: string) => void>,
    required: true
  },
  settings: {
    type: Object as PropType<Settings>,
    required: true
  },
  saveBaseUrl: {
    type: Function as PropType<() => void>,
    required: true
  },
  tokenVisible: {
    type: Boolean,
    required: true
  },
  bearerToken: {
    type: String,
    required: true
  },
  setBearerToken: {
    type: Function as PropType<(value: string) => void>,
    required: true
  },
  hasToken: {
    type: Boolean,
    required: true
  },
  toggleToken: {
    type: Function as PropType<() => void>,
    required: true
  },
  testConnection: {
    type: Function as PropType<() => void>,
    required: true
  },
  saveBearerToken: {
    type: Function as PropType<() => void>,
    required: true
  },
  statusClass: {
    type: Function as PropType<(status: StatusMessage) => Record<string, boolean>>,
    required: true
  },
  connectionStatus: {
    type: Object as PropType<StatusMessage>,
    required: true
  },
  modelOptions: {
    type: Array as PropType<string[]>,
    required: true
  },
  saveModelSettings: {
    type: Function as PropType<() => void>,
    required: true
  },
  modelsStatus: {
    type: Object as PropType<StatusMessage>,
    required: true
  },
  chatSettings: {
    type: Object as PropType<ChatSettings>,
    required: true
  },
  temperatureSlider: {
    type: Number,
    required: true
  },
  setTemperatureSlider: {
    type: Function as PropType<(value: number) => void>,
    required: true
  },
  temperatureDisplay: {
    type: String,
    required: true
  },
  toggleAutocomplete: {
    type: Function as PropType<() => void>,
    required: true
  },
  autocomplete: {
    type: Object as PropType<AutocompleteSettings>,
    required: true
  },
  agentSettings: {
    type: Object as PropType<AgentSettings>,
    required: true
  },
  toolTimeoutSeconds: {
    type: Number,
    required: true
  },
  setToolTimeoutSeconds: {
    type: Function as PropType<(value: number) => void>,
    required: true
  },
  saveAgentSettings: {
    type: Function as PropType<() => void>,
    required: true
  },
  agentStatus: {
    type: Object as PropType<StatusMessage>,
    required: true
  },
  tools: {
    type: Array as PropType<ToolItem[]>,
    required: true
  },
  runDbMaintenance: {
    type: Function as PropType<() => void>,
    required: true
  },
  dbMaintenanceStatus: {
    type: Object as PropType<StatusMessage>,
    required: true
  },
  recreateMessagesTable: {
    type: Function as PropType<() => void>,
    required: true
  },
  recreateMessagesStatus: {
    type: Object as PropType<StatusMessage>,
    required: true
  }
});

const onBearerInput = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  props.setBearerToken(value);
};

const onTemperatureInput = (event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  props.setTemperatureSlider(value);
};

const onToolTimeoutInput = (event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  props.setToolTimeoutSeconds(value);
};

const confirmRecreateMessagesTable = () => {
  // Use backend confirmation since webview sandbox blocks confirm()
  props.recreateMessagesTable();
};

// Session-level sensitive file pattern override
const localSessionPatterns = ref('');

watch(
  () => sessionSensitiveFilePatterns.value,
  (value) => {
    localSessionPatterns.value = value || '';
  },
  { immediate: true }
);

const saveSessionPatterns = () => {
  updateSessionSensitivePatterns(localSessionPatterns.value);
};
</script>
