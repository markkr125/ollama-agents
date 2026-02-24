import * as vscode from 'vscode';
import type { ExecutorConfig } from '../types/agent';
import { AgentConfig, ExtensionConfig, ModeConfig } from '../types/config';
import { DEFAULT_SENSITIVE_FILE_PATTERNS } from '../utils/fileSensitivity';

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('ollamaCopilot');

  return {
    baseUrl: config.get('baseUrl', 'http://localhost:11434'),
    contextWindow: config.get('contextWindow', 16000),
    storagePath: config.get('storagePath', ''),
    completionMode: {
      model: config.get('completionMode.model', ''),
      temperature: config.get('completionMode.temperature', 0.1),
      maxTokens: config.get('completionMode.maxTokens', 500)
    },
    chatMode: {
      model: config.get('chatMode.model', ''),
      temperature: config.get('chatMode.temperature', 0.7),
      maxTokens: config.get('chatMode.maxTokens', 2048)
    },
    planMode: {
      model: config.get('planMode.model', ''),
      temperature: config.get('planMode.temperature', 0.5),
      maxTokens: config.get('planMode.maxTokens', 4096)
    },
    agentMode: {
      model: config.get('agentMode.model', ''),
      temperature: config.get('agentMode.temperature', 0.4),
      maxTokens: config.get('agentMode.maxTokens', 8192)
    },

    agent: {
      maxIterations: config.get('agent.maxIterations', 25),
      toolTimeout: config.get('agent.toolTimeout', 30000),
      maxActiveSessions: config.get('agent.maxActiveSessions', 1),
      sensitiveFilePatterns: config.get(
        'agent.sensitiveFilePatterns',
        DEFAULT_SENSITIVE_FILE_PATTERNS
      ),
      enableThinking: config.get('agent.enableThinking', true),
      continuationStrategy: config.get('agent.continuationStrategy', 'full') as 'full' | 'standard' | 'minimal',
      keepAlive: config.get('agent.keepAlive', ''),
      sessionTitleGeneration: config.get('agent.sessionTitleGeneration', 'firstMessage') as 'currentModel' | 'selectModel' | 'firstMessage',
      sessionTitleModel: config.get('agent.sessionTitleModel', ''),
      maxContextWindow: config.get('agent.maxContextWindow', 65536),
      explorerModel: config.get('agent.explorerModel', '')
    }
  };
}

export async function updateConfig(section: string, value: any): Promise<void> {
  const config = vscode.workspace.getConfiguration('ollamaCopilot');
  await config.update(section, value, vscode.ConfigurationTarget.Global);
}

export function getModeConfig(mode: 'completion' | 'chat' | 'plan' | 'agent'): ModeConfig {
  const config = getConfig();
  const modeMap = {
    completion: config.completionMode,
    chat: config.chatMode,
    plan: config.planMode,
    agent: config.agentMode
  };
  return modeMap[mode];
}

export function getAgentConfig(): AgentConfig {
  return getConfig().agent;
}

/**
 * Build an `ExecutorConfig` from the VS Code configuration.
 * Assembles values from `agentMode` (temperature) and `agent`
 * (maxIterations, toolTimeout, explorerModel) sections.
 *
 * @param overrides — optional partial overrides (e.g. session-level explorerModel).
 */
export function buildExecutorConfig(overrides?: Partial<ExecutorConfig>): ExecutorConfig {
  const { agentMode, agent } = getConfig();
  return {
    maxIterations: agent.maxIterations,
    toolTimeout: agent.toolTimeout,
    temperature: agentMode.temperature,
    explorerModel: agent.explorerModel,
    ...overrides,
  };
}
