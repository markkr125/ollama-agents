import { bearerToken, isGenerating, modelInfo, modelOptions, settings, thinking } from '../state';

export const updateThinking = (visible: boolean, message?: string) => {
  thinking.visible = visible;
  if (message) {
    thinking.text = message;
  }
};

export const clearToken = () => {
  bearerToken.value = '';
};

export const setGenerating = (value: boolean) => {
  isGenerating.value = value;
  if (!value) {
    updateThinking(false);
  }
};

export const updateInitState = (msg: any) => {
  const models = msg.models || [];
  modelInfo.value = models;
  const modelNames = models.filter((m: any) => m.enabled !== false).map((m: { name: string }) => m.name);
  modelOptions.value = modelNames;
  return modelNames;
};

export const applySettings = (msg: any) => {
  if (!msg.settings) return;
  settings.baseUrl = msg.settings.baseUrl || 'http://localhost:11434';
  settings.enableAutoComplete = !!msg.settings.enableAutoComplete;
  settings.agentModel = msg.settings.agentModel || '';
  settings.askModel = msg.settings.askModel || '';
  settings.editModel = msg.settings.editModel || '';
  settings.completionModel = msg.settings.completionModel || '';
  settings.maxIterations = msg.settings.maxIterations || settings.maxIterations;
  settings.toolTimeout = msg.settings.toolTimeout || settings.toolTimeout;
  settings.maxActiveSessions = msg.settings.maxActiveSessions ?? settings.maxActiveSessions;
  settings.enableThinking = msg.settings.enableThinking ?? settings.enableThinking;
  settings.temperature = msg.settings.temperature ?? settings.temperature;
  settings.sensitiveFilePatterns = msg.settings.sensitiveFilePatterns ?? settings.sensitiveFilePatterns;
};
