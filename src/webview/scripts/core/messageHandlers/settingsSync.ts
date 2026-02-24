/**
 * Handlers for settings page state: initialization, settings sync,
 * connection status, DB maintenance, model capabilities, and navigation.
 *
 * Split from sessions.ts to keep that file focused on session list management.
 */
import {
    applySettings,
    clearToken,
    showStatus,
    updateInitState
} from '../actions/index';
import {
    capabilityCheckProgress,
    connectionStatus,
    currentMode,
    currentModel,
    currentPage,
    dbMaintenanceStatus,
    hasToken,
    isFirstRun,
    modelInfo,
    modelOptions,
    pendingPlanContent,
    recreateMessagesStatus,
    settings,
    temperatureSlider
} from '../state';
import type { InitMessage } from '../types';
import { syncModelSelection } from './threadUtils';

export const handleInit = (msg: InitMessage) => {
  modelOptions.value = updateInitState(msg);
  if (msg.currentMode) currentMode.value = msg.currentMode;
  applySettings(msg);
  temperatureSlider.value = Math.round(settings.temperature * 100);
  if (settings.agentModel) {
    currentModel.value = settings.agentModel;
  }
  syncModelSelection();
  hasToken.value = !!msg.hasToken;
  pendingPlanContent.value = null;
};

export const handleSettingsUpdate = (msg: any) => {
  applySettings(msg);
  temperatureSlider.value = Math.round(settings.temperature * 100);
  if (settings.agentModel) {
    currentModel.value = settings.agentModel;
  }
  syncModelSelection();
  hasToken.value = !!msg.hasToken;
};

export const handleConnectionTestResult = (msg: any) => {
  showStatus(connectionStatus, msg.message || '', !!msg.success);
  if (Array.isArray(msg.models)) {
    modelInfo.value = msg.models;
    modelOptions.value = msg.models.filter((m: any) => m.enabled !== false).map((m: { name: string }) => m.name);
    syncModelSelection();
  }
};

export const handleConnectionError = (msg: any) => {
  showStatus(connectionStatus, `Connection error: ${msg.error}`, false);
};

export const handleBearerTokenSaved = () => {
  clearToken();
};

export const handleDbMaintenanceResult = (msg: any) => {
  const success = !!msg.success;
  const deletedSessions = msg.deletedSessions ?? 0;
  const deletedMessages = msg.deletedMessages ?? 0;
  const message = success
    ? `Maintenance complete. Removed ${deletedSessions} session(s), ${deletedMessages} message(s).`
    : (msg.message || 'Database maintenance failed.');
  showStatus(dbMaintenanceStatus, message, success);
};

export const handleRecreateMessagesResult = (msg: any) => {
  const success = !!msg.success;
  const message = msg.message || (success ? 'Messages table recreated.' : 'Failed to recreate messages table.');
  showStatus(recreateMessagesStatus, message, success);
};

export const handleNavigateToSettings = (msg: any) => {
  currentPage.value = 'settings';
  isFirstRun.value = !!msg.isFirstRun;
};

export const handleModelEnabledChanged = (msg: any) => {
  if (Array.isArray(msg.models)) {
    modelInfo.value = msg.models;
    modelOptions.value = msg.models.filter((m: any) => m.enabled !== false).map((m: { name: string }) => m.name);
    syncModelSelection();
  }
};

export const handleCapabilityCheckProgress = (msg: any) => {
  capabilityCheckProgress.running = true;
  capabilityCheckProgress.completed = msg.completed || 0;
  capabilityCheckProgress.total = msg.total || 0;
  if (Array.isArray(msg.models)) {
    modelInfo.value = msg.models;
  }
};

export const handleCapabilityCheckComplete = () => {
  capabilityCheckProgress.running = false;
};
