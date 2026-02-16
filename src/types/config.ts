// Configuration types

export interface ModeConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface AgentConfig {
  maxIterations: number;
  toolTimeout: number;
  maxActiveSessions: number;
  sensitiveFilePatterns: Record<string, boolean>;
  enableThinking: boolean;
}

export interface ExtensionConfig {
  baseUrl: string;
  contextWindow: number;
  storagePath: string;
  completionMode: ModeConfig;
  askMode: ModeConfig;
  editMode: ModeConfig;
  planMode: ModeConfig;
  agentMode: ModeConfig;
  exploreMode: ModeConfig;
  reviewMode: ModeConfig;
  agent: AgentConfig;
}
