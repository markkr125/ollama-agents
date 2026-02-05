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
}

export interface ExtensionConfig {
  baseUrl: string;
  contextWindow: number;
  completionMode: ModeConfig;
  askMode: ModeConfig;
  editMode: ModeConfig;
  planMode: ModeConfig;
  agentMode: ModeConfig;
  agent: AgentConfig;
}
