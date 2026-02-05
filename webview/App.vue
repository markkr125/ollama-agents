<template>
  <div class="app">
    <div class="main-panel">
      <HeaderBar
        :current-page="currentPage"
        :header-title="headerTitle"
        :show-page="showPage"
        :new-chat="newChat"
      />

      <ChatPage
        :current-page="currentPage"
        :set-messages-el="setMessagesEl"
        :set-input-el="setInputEl"
        :timeline="timeline"
        :thinking="thinking"
        :context-list="contextList"
        :input-text="inputText"
        :set-input-text="setInputTextValue"
        :current-mode="currentMode"
        :set-current-mode="setCurrentModeValue"
        :current-model="currentModel"
        :set-current-model="setCurrentModelValue"
        :model-options="modelOptions"
        :auto-approve-commands="autoApproveCommands"
        :toggle-auto-approve-commands="toggleAutoApproveCommands"
        :auto-approve-confirm-visible="autoApproveConfirmVisible"
        :confirm-auto-approve-commands="confirmAutoApproveCommands"
        :cancel-auto-approve-commands="cancelAutoApproveCommands"
        :approve-command="approveCommand"
        :skip-command="skipCommand"
        :approve-file-edit="approveFileEdit"
        :skip-file-edit="skipFileEdit"
        :open-file-diff="openFileDiff"
        :is-generating="isGenerating"
        :format-markdown="formatMarkdown"
        :toggle-progress="toggleProgress"
        :action-status-class="actionStatusClass"
        :add-context="addContext"
        :remove-context="removeContext"
        :handle-enter="handleEnter"
        :handle-send="handleSend"
        :resize-input="resizeInput"
        :select-mode="selectMode"
        :select-model="selectModel"
        :scroll-target-message-id="scrollTargetMessageId"
        :clear-scroll-target="clearScrollTarget"
        :auto-approve-sensitive-edits="autoApproveSensitiveEdits"
        :toggle-auto-approve-sensitive-edits="toggleAutoApproveSensitiveEdits"
      />

      <SettingsPage
        :current-page="currentPage"
        :active-section="activeSection"
        :set-active-section="setActiveSection"
        :settings="settings"
        :save-base-url="saveBaseUrl"
        :token-visible="tokenVisible"
        :bearer-token="bearerToken"
        :set-bearer-token="setBearerTokenValue"
        :has-token="hasToken"
        :toggle-token="toggleToken"
        :test-connection="testConnection"
        :save-bearer-token="saveBearerToken"
        :status-class="statusClass"
        :connection-status="connectionStatus"
        :model-options="modelOptions"
        :save-model-settings="saveModelSettings"
        :models-status="modelsStatus"
        :chat-settings="chatSettings"
        :temperature-slider="temperatureSlider"
        :set-temperature-slider="setTemperatureSliderValue"
        :temperature-display="temperatureDisplay"
        :toggle-autocomplete="toggleAutocomplete"
        :autocomplete="autocomplete"
        :agent-settings="agentSettings"
        :tool-timeout-seconds="toolTimeoutSeconds"
        :set-tool-timeout-seconds="setToolTimeoutSecondsValue"
        :save-agent-settings="saveAgentSettings"
        :agent-status="agentStatus"
        :run-db-maintenance="runDbMaintenance"
        :db-maintenance-status="dbMaintenanceStatus"
        :recreate-messages-table="recreateMessagesTable"
        :recreate-messages-status="recreateMessagesStatus"
        :tools="tools"
      />

      <SessionsPanel
        :current-page="currentPage"
        :sessions="sessions"
        :has-more-sessions="sessionsHasMore"
        :is-loading-more="sessionsLoading"
        :search-query="searchQuery"
        :search-results="searchResults"
        :search-has-more="searchHasMore"
        :is-search-revealing="searchIsRevealing"
        :is-searching="isSearching"
        :load-session="loadSession"
        :delete-session="deleteSession"
        :format-time="formatTime"
        :handle-search-input="handleSearchInput"
        :clear-search="clearSearch"
        :load-session-with-message="loadSessionWithMessage"
        :load-more-sessions="loadMoreSessions"
        :reveal-more-search-results="revealMoreSearchResults"
        :highlight-snippet="highlightSnippet"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import ChatPage from './components/ChatPage.vue';
import HeaderBar from './components/HeaderBar.vue';
import SessionsPanel from './components/SessionsPanel.vue';
import SettingsPage from './components/SettingsPage.vue';
import {
  actionStatusClass,
  activeSection,
  addContext,
  agentSettings,
  agentStatus,
  approveCommand,
  approveFileEdit,
  autoApproveCommands,
  autoApproveConfirmVisible,
  autoApproveSensitiveEdits,
  autocomplete,
  bearerToken,
  cancelAutoApproveCommands,
  chatSettings,
  clearScrollTarget,
  clearSearch,
  confirmAutoApproveCommands,
  connectionStatus,
  contextList,
  currentMode,
  currentModel,
  currentPage,
  dbMaintenanceStatus,
  deleteSession,
  formatMarkdown,
  formatTime,
  handleEnter,
  handleSearchInput,
  handleSend,
  hasToken,
  headerTitle,
  highlightSnippet,
  inputEl,
  inputText,
  isGenerating,
  isSearching,
  loadMoreSessions,
  loadSession,
  loadSessionWithMessage,
  messagesEl,
  modelOptions,
  modelsStatus,
  newChat,
  openFileDiff,
  recreateMessagesStatus,
  recreateMessagesTable,
  removeContext,
  resizeInput,
  revealMoreSearchResults,
  runDbMaintenance,
  saveAgentSettings,
  saveBaseUrl,
  saveBearerToken,
  saveModelSettings,
  scrollTargetMessageId,
  searchHasMore,
  searchIsRevealing,
  searchQuery,
  searchResults,
  selectMode,
  selectModel,
  sessions,
  sessionsHasMore,
  sessionsLoading,
  settings,
  showPage,
  skipCommand,
  skipFileEdit,
  statusClass,
  temperatureDisplay,
  temperatureSlider,
  testConnection,
  thinking,
  timeline,
  toggleAutoApproveCommands,
  toggleAutoApproveSensitiveEdits,
  toggleAutocomplete,
  toggleProgress,
  toggleToken,
  tokenVisible,
  tools,
  toolTimeoutSeconds,
  vscode
} from './scripts/app/App';

// Initialize when mounted - send ready message to extension
onMounted(() => {
  vscode.postMessage({ type: 'ready' });
  resizeInput();
});

const setActiveSection = (section: string) => {
  activeSection.value = section;
};

const setInputTextValue = (value: string) => {
  inputText.value = value;
};

const setCurrentModeValue = (value: string) => {
  currentMode.value = value;
};

const setCurrentModelValue = (value: string) => {
  currentModel.value = value;
};

const setMessagesEl = (value: HTMLDivElement | null) => {
  messagesEl.value = value;
};

const setInputEl = (value: HTMLTextAreaElement | null) => {
  inputEl.value = value;
};

const setBearerTokenValue = (value: string) => {
  bearerToken.value = value;
};

const setTemperatureSliderValue = (value: number) => {
  temperatureSlider.value = value;
};

const setToolTimeoutSecondsValue = (value: number) => {
  toolTimeoutSeconds.value = value;
};

</script>
