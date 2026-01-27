// Model compatibility checking

/**
 * Models known to support Fill-In-Middle (FIM) prompting
 */
export const FIM_CAPABLE_MODELS: RegExp[] = [
  /codellama/i,
  /deepseek[-_]coder/i,
  /qwen.*coder/i,
  /starcoder/i,
  /granite[-_]code/i,
  /codegemma/i,
  /stable[-_]code/i
];

/**
 * Models known to support structured tool calling
 */
export const TOOL_CAPABLE_MODELS: RegExp[] = [
  /llama3\.[123]/i,
  /llama[-_]?3\.[123]/i,
  /qwen2\.5/i,
  /mistral/i,
  /mixtral/i,
  /command[-_]r/i,
  /gemini/i,
  /gpt/i
];

export interface CompatibilityCheck {
  compatible: boolean;
  warning?: string;
  recommendation?: string;
}

/**
 * Check if a model supports FIM (Fill-In-Middle) prompting
 */
export function isFIMCapable(modelName: string): boolean {
  return FIM_CAPABLE_MODELS.some(pattern => pattern.test(modelName));
}

/**
 * Check if a model supports tool calling
 */
export function isToolCapable(modelName: string): boolean {
  return TOOL_CAPABLE_MODELS.some(pattern => pattern.test(modelName));
}

/**
 * Check model compatibility for a specific capability
 */
export function checkCompatibility(
  modelName: string,
  required: 'fim' | 'tool' | 'both'
): CompatibilityCheck {
  const hasFIM = isFIMCapable(modelName);
  const hasTool = isToolCapable(modelName);

  switch (required) {
    case 'fim':
      if (!hasFIM) {
        return {
          compatible: false,
          warning: `Model '${modelName}' may not support FIM (Fill-In-Middle) prompting`,
          recommendation: 'Consider using codellama, deepseek-coder, or qwen-coder for better completions'
        };
      }
      return { compatible: true };

    case 'tool':
      if (!hasTool) {
        return {
          compatible: false,
          warning: `Model '${modelName}' may not support tool calling`,
          recommendation: 'Consider using llama3.1+, qwen2.5+, or mistral for agent mode'
        };
      }
      return { compatible: true };

    case 'both':
      if (!hasFIM || !hasTool) {
        const missing = [];
        if (!hasFIM) {missing.push('FIM');}
        if (!hasTool) {missing.push('tool calling');}
        return {
          compatible: false,
          warning: `Model '${modelName}' may not support ${missing.join(' or ')}`,
          recommendation: 'Consider using qwen2.5-coder for full compatibility'
        };
      }
      return { compatible: true };
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
