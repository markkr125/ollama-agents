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
        :auto-approve-sensitive-edits-confirm-visible="autoApproveSensitiveEditsConfirmVisible"
        :confirm-auto-approve-sensitive-edits="confirmAutoApproveSensitiveEdits"
        :cancel-auto-approve-sensitive-edits="cancelAutoApproveSensitiveEdits"
        :implicit-file="implicitFile"
        :implicit-selection="implicitSelection"
        :implicit-file-enabled="implicitFileEnabled"
        :add-context-from-file="addContextFromFile"
        :add-context-current-file="addContextCurrentFile"
        :add-context-from-terminal="addContextFromTerminal"
        :toggle-implicit-file="toggleImplicitFile"
        :promote-implicit-file="promoteImplicitFile"
        :pin-selection="pinSelection"
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
        :model-info="modelInfo"
        :capability-check-progress="capabilityCheckProgress"
        :refresh-capabilities="refreshCapabilities"
        :toggle-model-enabled="toggleModelEnabled"
        :update-model-max-context="updateModelMaxContext"
        :save-max-context-window="saveMaxContextWindow"
        :save-model-settings="saveModelSettings"
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
        :save-storage-path="saveStoragePath"
        :db-maintenance-status="dbMaintenanceStatus"
        :recreate-messages-table="recreateMessagesTable"
        :recreate-messages-status="recreateMessagesStatus"
        :tools="tools"
      />

      <SessionsPanel
        :current-page="currentPage"
        :current-session-id="currentSessionId"
        :sessions="sessions"
        :sessions-initial-loaded="sessionsInitialLoaded"
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
        :relative-time="relativeTime"
        :handle-search-input="handleSearchInput"
        :clear-search="clearSearch"
        :load-session-with-message="loadSessionWithMessage"
        :load-more-sessions="loadMoreSessions"
        :reveal-more-search-results="revealMoreSearchResults"
        :highlight-snippet="highlightSnippet"
        :deleting-session-ids="deletingSessionIds"
        :selection-mode="selectionMode"
        :selected-session-ids="selectedSessionIds"
        :deletion-progress="deletionProgress"
        :toggle-selection-mode="toggleSelectionMode"
        :toggle-session-selection="toggleSessionSelection"
        :select-all-sessions="selectAllSessions"
        :delete-selected-sessions="deleteSelectedSessions"
        :clear-selection="clearSelection"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import ChatPage from './components/chat/ChatPage.vue';
import HeaderBar from './components/HeaderBar.vue';
import SessionsPanel from './components/SessionsPanel.vue';
import SettingsPage from './components/settings/SettingsPage.vue';
import {
    actionStatusClass,
    activeSection,
    addContext,
    addContextCurrentFile,
    addContextFromFile,
    addContextFromTerminal,
    agentSettings,
    agentStatus,
    approveCommand,
    approveFileEdit,
    autoApproveCommands,
    autoApproveConfirmVisible,
    autoApproveSensitiveEdits,
    autoApproveSensitiveEditsConfirmVisible,
    autocomplete,
    bearerToken,
    cancelAutoApproveCommands,
    cancelAutoApproveSensitiveEdits,
    capabilityCheckProgress,
    chatSettings,
    clearScrollTarget,
    clearSearch,
    clearSelection,
    confirmAutoApproveCommands,
    confirmAutoApproveSensitiveEdits,
    connectionStatus,
    contextList,
    currentMode,
    currentModel,
    currentPage,
    currentSessionId,
    dbMaintenanceStatus,
    deleteSelectedSessions,
    deleteSession,
    deletingSessionIds,
    deletionProgress,
    formatTime,
    handleEnter,
    handleSearchInput,
    handleSend,
    hasToken,
    headerTitle,
    highlightSnippet,
    implicitFile,
    implicitFileEnabled,
    implicitSelection,
    inputEl,
    inputText,
    isGenerating,
    isSearching,
    loadMoreSessions,
    loadSession,
    loadSessionWithMessage,
    messagesEl,
    modelInfo,
    modelOptions,
    newChat,
    openFileDiff,
    pinSelection,
    promoteImplicitFile,
    recreateMessagesStatus,
    recreateMessagesTable,
    refreshCapabilities,
    relativeTime,
    removeContext,
    resizeInput,
    revealMoreSearchResults,
    runDbMaintenance,
    saveAgentSettings,
    saveBaseUrl,
    saveBearerToken,
    saveMaxContextWindow,
    saveModelSettings,
    saveStoragePath,
    scrollTargetMessageId,
    searchHasMore,
    searchIsRevealing,
    searchQuery,
    searchResults,
    selectAllSessions,
    selectedSessionIds,
    selectionMode,
    selectMode,
    selectModel,
    sessions,
    sessionsHasMore,
    sessionsInitialLoaded,
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
    toggleImplicitFile,
    toggleModelEnabled,
    toggleProgress,
    toggleSelectionMode,
    toggleSessionSelection,
    toggleToken,
    tokenVisible,
    tools,
    toolTimeoutSeconds,
    updateModelMaxContext,
    vscode
} from './scripts/app/App';

// Initialize when mounted - send ready message to extension
onMounted(() => {
  const savedState = vscode.getState?.();
  vscode.postMessage({ type: 'ready', sessionId: savedState?.sessionId });
  if (savedState?.currentPage) {
    currentPage.value = savedState.currentPage;
  }
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
