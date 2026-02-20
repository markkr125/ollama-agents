import {
    agentSettings,
    agentStatus,
    bearerToken,
    dbMaintenanceStatus,
    hasToken,
    recreateMessagesStatus,
    settings,
    tokenVisible,
    vscode
} from '../state';
import { showStatus } from './status';

export const toggleToken = () => {
  tokenVisible.value = !tokenVisible.value;
};

export const saveBearerToken = () => {
  if (!bearerToken.value) return;
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
  vscode.postMessage({
    type: 'saveBearerToken',
    token: bearerToken.value,
    testAfterSave: true,
    baseUrl: settings.baseUrl
  });
  hasToken.value = true;
};

export const testConnection = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
  vscode.postMessage({ type: 'testConnection', baseUrl: settings.baseUrl });
};

export const saveBaseUrl = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
};

export const saveModelSettings = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      agentModel: settings.agentModel,
      chatModel: settings.chatModel,
      completionModel: settings.completionModel
    }
  });
};

export const saveAgentSettings = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      maxIterations: settings.maxIterations,
      toolTimeout: settings.toolTimeout,
      maxActiveSessions: settings.maxActiveSessions,
      sensitiveFilePatterns: settings.sensitiveFilePatterns,
      enableThinking: settings.enableThinking,
      continuationStrategy: settings.continuationStrategy,
      autoCreateBranch: agentSettings.autoCreateBranch,
      autoCommit: agentSettings.autoCommit
    }
  });
  showStatus(agentStatus, 'Agent settings saved!', true);
};

export const runDbMaintenance = () => {
  showStatus(dbMaintenanceStatus, 'Running database maintenance...', true);
  vscode.postMessage({ type: 'runDbMaintenance' });
};

export const recreateMessagesTable = () => {
  showStatus(recreateMessagesStatus, 'Recreating messages table...', true);
  vscode.postMessage({ type: 'recreateMessagesTable' });
};

export const saveStoragePath = (value: string) => {
  settings.storagePath = value;
  vscode.postMessage({
    type: 'saveSettings',
    settings: { storagePath: value }
  });
};

export const toggleAutocomplete = () => {
  settings.enableAutoComplete = !settings.enableAutoComplete;
  vscode.postMessage({
    type: 'saveSettings',
    settings: { enableAutoComplete: settings.enableAutoComplete }
  });
};

export const refreshCapabilities = () => {
  vscode.postMessage({ type: 'refreshCapabilities' });
};

export const toggleModelEnabled = (modelName: string, enabled: boolean) => {
  vscode.postMessage({ type: 'toggleModelEnabled', modelName, enabled });
};

export const updateModelMaxContext = (modelName: string, maxContext: number | null) => {
  vscode.postMessage({ type: 'updateModelMaxContext', modelName, maxContext });
};

export const saveMaxContextWindow = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: { maxContextWindow: settings.maxContextWindow }
  });
};
