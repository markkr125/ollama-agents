import {
    agentSettings,
    agentStatus,
    bearerToken,
    dbMaintenanceStatus,
    hasToken,
    modelsStatus,
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
  vscode.postMessage({ type: 'saveBearerToken', token: bearerToken.value, testAfterSave: true });
  hasToken.value = true;
};

export const testConnection = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: { baseUrl: settings.baseUrl }
  });
  vscode.postMessage({ type: 'testConnection' });
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
      askModel: settings.askModel,
      editModel: settings.editModel,
      completionModel: settings.completionModel
    }
  });
  showStatus(modelsStatus, 'Model settings saved!', true);
};

export const saveAgentSettings = () => {
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      maxIterations: settings.maxIterations,
      toolTimeout: settings.toolTimeout,
      maxActiveSessions: settings.maxActiveSessions,
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

export const toggleAutocomplete = () => {
  settings.enableAutoComplete = !settings.enableAutoComplete;
  vscode.postMessage({
    type: 'saveSettings',
    settings: { enableAutoComplete: settings.enableAutoComplete }
  });
};
