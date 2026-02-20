<template>
  <div class="page" :class="{ active: currentPage === 'settings' }">
    <div class="settings-outer">
      <!-- Welcome banner for first-run -->
      <div v-if="isFirstRun" class="welcome-banner">
        <div class="welcome-content">
          <h2>🤖 Welcome to Ollama Copilot!</h2>
          <p>Let's get you set up. Configure your Ollama server connection below, then pick your models.</p>
          <button class="btn btn-secondary welcome-dismiss" @click="dismissWelcome">Dismiss</button>
        </div>
      </div>

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
          <ConnectionSection
            :activeSection="activeSection"
            :settings="settings"
            :saveBaseUrl="saveBaseUrl"
            :tokenVisible="tokenVisible"
            :bearerToken="bearerToken"
            :onBearerInput="onBearerInput"
            :hasToken="hasToken"
            :toggleToken="toggleToken"
            :testConnection="testConnection"
            :saveBearerToken="saveBearerToken"
            :statusClass="statusClass"
            :connectionStatus="connectionStatus"
          />
          <ModelCapabilitiesSection
            :activeSection="activeSection"
            :modelInfo="modelInfo"
            :capabilityCheckProgress="capabilityCheckProgress"
            :refreshCapabilities="refreshCapabilities"
            :toggleModelEnabled="toggleModelEnabled"
            :updateModelMaxContext="updateModelMaxContext"
            :saveMaxContextWindow="saveMaxContextWindow"
            :settings="settings"
            :modelOptions="modelOptions"
            :saveModelSettings="saveModelSettings"
          />
          <ChatSection
            :activeSection="activeSection"
            :chatSettings="chatSettings"
            :temperatureSlider="temperatureSlider"
            :temperatureDisplay="temperatureDisplay"
            :onTemperatureInput="onTemperatureInput"
          />
          <AutocompleteSection
            :activeSection="activeSection"
            :settings="settings"
            :autocomplete="autocomplete"
            :toggleAutocomplete="toggleAutocomplete"
          />
          <AgentSection
            v-model:localSessionPatterns="localSessionPatterns"
            :activeSection="activeSection"
            :settings="settings"
            :toolTimeoutSeconds="toolTimeoutSeconds"
            :onToolTimeoutInput="onToolTimeoutInput"
            :saveSessionPatterns="saveSessionPatterns"
            :agentSettings="agentSettings"
            :saveAgentSettings="saveAgentSettings"
            :statusClass="statusClass"
            :agentStatus="agentStatus"
          />
          <ToolsSection
            :activeSection="activeSection"
            :tools="tools"
          />
          <AdvancedSection
            :activeSection="activeSection"
            :storagePath="settings.storagePath"
            :saveStoragePath="saveStoragePath"
            :runDbMaintenance="runDbMaintenance"
            :statusClass="statusClass"
            :dbMaintenanceStatus="dbMaintenanceStatus"
            :confirmRecreateMessagesTable="confirmRecreateMessagesTable"
            :recreateMessagesStatus="recreateMessagesStatus"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SettingsPageProps } from '../../scripts/core/settings';
import { useSettingsPage } from '../../scripts/core/settings';
import { isFirstRun } from '../../scripts/core/state';
import AdvancedSection from './components/AdvancedSection.vue';
import AgentSection from './components/AgentSection.vue';
import AutocompleteSection from './components/AutocompleteSection.vue';
import ChatSection from './components/ChatSection.vue';
import ConnectionSection from './components/ConnectionSection.vue';
import ModelCapabilitiesSection from './components/ModelCapabilitiesSection.vue';
import ToolsSection from './components/ToolsSection.vue';

const props = defineProps<SettingsPageProps>();

const {
  onBearerInput,
  onTemperatureInput,
  onToolTimeoutInput,
  confirmRecreateMessagesTable,
  localSessionPatterns,
  saveSessionPatterns,
  dismissWelcome,
} = useSettingsPage(props);
</script>
