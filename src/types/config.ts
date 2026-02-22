// Configuration types

export interface ModeConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export type ContinuationStrategy = 'full' | 'standard' | 'minimal';

export interface AgentConfig {
  maxIterations: number;
  toolTimeout: number;
  maxActiveSessions: number;
  sensitiveFilePatterns: Record<string, boolean>;
  enableThinking: boolean;
  continuationStrategy: ContinuationStrategy;
  keepAlive: string;
  sessionTitleGeneration: 'currentModel' | 'selectModel' | 'firstMessage';
  sessionTitleModel: string;
  maxContextWindow: number;
  explorerModel: string;
}

export interface ExtensionConfig {
  baseUrl: string;
  contextWindow: number;
  storagePath: string;
  completionMode: ModeConfig;
  chatMode: ModeConfig;
  planMode: ModeConfig;
  agentMode: ModeConfig;
  agent: AgentConfig;
}
