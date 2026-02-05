import * as vscode from 'vscode';
import { AgentConfig, ExtensionConfig, ModeConfig } from '../types/config';
import { DEFAULT_SENSITIVE_FILE_PATTERNS } from '../utils/fileSensitivity';

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('ollamaCopilot');

  return {
    baseUrl: config.get('baseUrl', 'http://localhost:11434'),
    contextWindow: config.get('contextWindow', 16000),
    completionMode: {
      model: config.get('completionMode.model', ''),
      temperature: config.get('completionMode.temperature', 0.1),
      maxTokens: config.get('completionMode.maxTokens', 500)
    },
    askMode: {
      model: config.get('askMode.model', ''),
      temperature: config.get('askMode.temperature', 0.7),
      maxTokens: config.get('askMode.maxTokens', 2048)
    },
    editMode: {
      model: config.get('editMode.model', ''),
      temperature: config.get('editMode.temperature', 0.3),
      maxTokens: config.get('editMode.maxTokens', 4096)
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
      )
    }
  };
}

export async function updateConfig(section: string, value: any): Promise<void> {
  const config = vscode.workspace.getConfiguration('ollamaCopilot');
  await config.update(section, value, vscode.ConfigurationTarget.Global);
}

export function getModeConfig(mode: 'completion' | 'ask' | 'edit' | 'plan' | 'agent'): ModeConfig {
  const config = getConfig();
  const modeMap = {
    completion: config.completionMode,
    ask: config.askMode,
    edit: config.editMode,
    plan: config.planMode,
    agent: config.agentMode
  };
  return modeMap[mode];
}

export function getAgentConfig(): AgentConfig {
  return getConfig().agent;
}
