// --- Shared types for SettingsPage ---

import type { ModelInfo } from '../types';

export type StatusMessage = {
  visible: boolean;
  success: boolean;
  message: string;
};

export type CapabilityCheckProgress = {
  running: boolean;
  completed: number;
  total: number;
};

export type Settings = {
  baseUrl: string;
  enableAutoComplete: boolean;
  agentModel: string;
  askModel: string;
  editModel: string;
  completionModel: string;
  maxIterations: number;
  toolTimeout: number;
  maxActiveSessions: number;
  enableThinking: boolean;
  temperature: number;
  sensitiveFilePatterns: string;
};

export type ChatSettings = {
  streamResponses: boolean;
  showToolActions: boolean;
};

export type AutocompleteSettings = {
  autoTrigger: boolean;
  triggerDelay: number;
  maxTokens: number;
};

export type AgentSettings = {
  autoCreateBranch: boolean;
  autoCommit: boolean;
};

export type ToolItem = {
  name: string;
  icon: string;
  desc: string;
};

// --- Props interface for SettingsPage component ---

export interface SettingsPageProps {
  currentPage: 'chat' | 'settings' | 'sessions';
  activeSection: string;
  setActiveSection: (section: string) => void;
  settings: Settings;
  saveBaseUrl: () => void;
  tokenVisible: boolean;
  bearerToken: string;
  setBearerToken: (value: string) => void;
  hasToken: boolean;
  toggleToken: () => void;
  testConnection: () => void;
  saveBearerToken: () => void;
  statusClass: (status: StatusMessage) => Record<string, boolean>;
  connectionStatus: StatusMessage;
  modelOptions: string[];
  modelInfo: ModelInfo[];
  capabilityCheckProgress: CapabilityCheckProgress;
  refreshCapabilities: () => void;
  toggleModelEnabled: (modelName: string, enabled: boolean) => void;
  saveModelSettings: () => void;
  chatSettings: ChatSettings;
  temperatureSlider: number;
  setTemperatureSlider: (value: number) => void;
  temperatureDisplay: string;
  toggleAutocomplete: () => void;
  autocomplete: AutocompleteSettings;
  agentSettings: AgentSettings;
  toolTimeoutSeconds: number;
  setToolTimeoutSeconds: (value: number) => void;
  saveAgentSettings: () => void;
  agentStatus: StatusMessage;
  tools: ToolItem[];
  runDbMaintenance: () => void;
  dbMaintenanceStatus: StatusMessage;
  recreateMessagesTable: () => void;
  recreateMessagesStatus: StatusMessage;
}

// --- Callbacks interface consumed by the composable ---

export interface SettingsPageCallbacks {
  setBearerToken: (value: string) => void;
  setTemperatureSlider: (value: number) => void;
  setToolTimeoutSeconds: (value: number) => void;
  recreateMessagesTable: () => void;
}
