// Model compatibility checking
//
// Capabilities are sourced from the Ollama /api/show endpoint which returns
// a `capabilities` string array (e.g. ["completion", "vision", "tools"]).
// This module maps those strings to the UI-facing ModelCapabilities type and
// provides helpers for the model-selection quick pick.

import type { Model } from '../types/ollama';

// ---- Capability names returned by /api/show ---------------------
// Known values (as of Ollama 0.6+):
//   "completion"  – can generate text
//   "vision"      – can process images
//   "tools"       – supports function/tool calling
//   "embedding"   – can produce embeddings
//   "insert"      – supports fill-in-middle (FIM)
// -----------------------------------------------------------------

/**
 * Capabilities detected for a model.
 */
export interface ModelCapabilities {
  chat: boolean;
  fim: boolean;
  tools: boolean;
  vision: boolean;
  embedding: boolean;
}

/**
 * Compute all capabilities for a model.
 * Reads from `model.capabilities` (populated by /api/show) when available.
 */
export function getModelCapabilities(model: Model): ModelCapabilities {
  const caps = model.capabilities ?? [];
  return {
    chat: caps.includes('completion'),
    fim: caps.includes('insert'),
    tools: caps.includes('tools'),
    vision: caps.includes('vision'),
    embedding: caps.includes('embedding')
  };
}

// ---- Compatibility check for model selection quick pick ----------

export interface CompatibilityCheck {
  compatible: boolean;
  warning?: string;
  recommendation?: string;
}

/**
 * Check model compatibility for a specific capability.
 * Uses the `model.capabilities` array when available.
 */
export function checkModelCompatibility(
  model: Model,
  required: 'fim' | 'tool' | 'both'
): CompatibilityCheck {
  const caps = getModelCapabilities(model);

  switch (required) {
    case 'fim':
      if (!caps.fim) {
        return {
          compatible: false,
          warning: `Model '${model.name}' may not support FIM (Fill-In-Middle) prompting`,
          recommendation: 'Consider using codellama, deepseek-coder, or qwen-coder for better completions'
        };
      }
      return { compatible: true };

    case 'tool':
      if (!caps.tools) {
        return {
          compatible: false,
          warning: `Model '${model.name}' may not support tool calling`,
          recommendation: 'Consider using llama3.1+, qwen2.5+, or mistral for agent mode'
        };
      }
      return { compatible: true };

    case 'both': {
      const missing: string[] = [];
      if (!caps.fim) { missing.push('FIM'); }
      if (!caps.tools) { missing.push('tool calling'); }
      if (missing.length > 0) {
        return {
          compatible: false,
          warning: `Model '${model.name}' may not support ${missing.join(' or ')}`,
          recommendation: 'Consider using qwen2.5-coder for full compatibility'
        };
      }
      return { compatible: true };
    }
  }
}

/**
 * Get recommended models for a capability
 */
export function getRecommendation(capability: 'fim' | 'tool' | 'both'): string[] {
  switch (capability) {
    case 'fim':
      return ['codellama:7b-code', 'deepseek-coder:6.7b', 'qwen2.5-coder:7b', 'starcoder2:7b'];
    case 'tool':
      return ['qwen2.5:7b', 'llama3.1:8b', 'mistral:7b', 'command-r:35b'];
    case 'both':
      return ['qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'deepseek-coder:33b'];
  }
}
