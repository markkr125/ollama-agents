// FIM (Fill-In-Middle) template system for code completion

export interface FIMTemplate {
  format: (prefix: string, suffix: string) => string;
}

/**
 * Model-specific FIM templates
 * Different models use different special tokens for FIM
 */
export const MODEL_TEMPLATES: Record<string, FIMTemplate> = {
  codellama: {
    format: (prefix, suffix) => `<PRE> ${prefix} <SUF>${suffix} <MID>`
  },
  
  deepseek: {
    format: (prefix, suffix) => `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`
  },
  
  starcoder: {
    format: (prefix, suffix) => `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`
  },
  
  qwen: {
    format: (prefix, suffix) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
  },

  granite: {
    format: (prefix, suffix) => `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`
  },

  codegemma: {
    format: (prefix, suffix) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|><|file_separator|>`
  },

  // Generic fallback for models without explicit FIM support
  generic: {
    format: (prefix, suffix) => 
      `Complete the following code:\n\n${prefix}[COMPLETE HERE]${suffix}\n\nComplete the code at [COMPLETE HERE]:`
  }
};

/**
 * Language-specific refinements
 * Add language context to improve completions
 */
export const LANGUAGE_REFINEMENTS: Record<string, (prompt: string) => string> = {
  python: (prompt) => `# Python code\n${prompt}`,
  javascript: (prompt) => `// JavaScript\n${prompt}`,
  typescript: (prompt) => `// TypeScript\n${prompt}`,
  java: (prompt) => `// Java\n${prompt}`,
  cpp: (prompt) => `// C++\n${prompt}`,
  c: (prompt) => `// C\n${prompt}`,
  csharp: (prompt) => `// C#\n${prompt}`,
  go: (prompt) => `// Go\n${prompt}`,
  rust: (prompt) => `// Rust\n${prompt}`,
  ruby: (prompt) => `# Ruby\n${prompt}`,
  php: (prompt) => `<?php\n${prompt}`,
  swift: (prompt) => `// Swift\n${prompt}`,
  kotlin: (prompt) => `// Kotlin\n${prompt}`,
  scala: (prompt) => `// Scala\n${prompt}`,
  r: (prompt) => `# R\n${prompt}`,
  sql: (prompt) => `-- SQL\n${prompt}`,
  html: (prompt) => `<!-- HTML -->\n${prompt}`,
  css: (prompt) => `/* CSS */\n${prompt}`,
  scss: (prompt) => `/* SCSS */\n${prompt}`,
  yaml: (prompt) => `# YAML\n${prompt}`,
  json: (prompt) => prompt, // No comment syntax
  markdown: (prompt) => prompt,
  shell: (prompt) => `# Shell script\n${prompt}`,
  bash: (prompt) => `# Bash script\n${prompt}`,
  powershell: (prompt) => `# PowerShell\n${prompt}`
};

/**
 * Detect model template from model name
 */
function detectModelTemplate(modelName: string): FIMTemplate {
  const lowerName = modelName.toLowerCase();

  if (lowerName.includes('codellama')) {
    return MODEL_TEMPLATES.codellama;
  }
  if (lowerName.includes('deepseek')) {
    return MODEL_TEMPLATES.deepseek;
  }
  if (lowerName.includes('starcoder')) {
    return MODEL_TEMPLATES.starcoder;
  }
  if (lowerName.includes('qwen')) {
    return MODEL_TEMPLATES.qwen;
  }
  if (lowerName.includes('granite')) {
    return MODEL_TEMPLATES.granite;
  }
  if (lowerName.includes('codegemma')) {
    return MODEL_TEMPLATES.codegemma;
  }

  return MODEL_TEMPLATES.generic;
}

/**
 * Get FIM prompt for code completion
 * @param prefix Code before cursor
 * @param suffix Code after cursor
 * @param modelName Name of the model being used
 * @param languageId Language ID of the document
 */
export function getFIMPrompt(
  prefix: string,
  suffix: string,
  modelName: string,
  languageId?: string
): string {
  const template = detectModelTemplate(modelName);
  let prompt = template.format(prefix, suffix);

  // Apply language-specific refinement if available
  if (languageId && LANGUAGE_REFINEMENTS[languageId]) {
    prompt = LANGUAGE_REFINEMENTS[languageId](prompt);
  }

  return prompt;
}

/**
 * Check if model likely supports FIM based on template detection
 */
export function hasFIMSupport(modelName: string): boolean {
  const template = detectModelTemplate(modelName);
  return template !== MODEL_TEMPLATES.generic;
}
