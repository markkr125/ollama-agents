// Ollama API types

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
    top_k?: number;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
    top_k?: number;
  };
  tools?: ToolDefinition[];
}

export interface StreamChunk {
  model?: string;
  response?: string;
  message?: ChatMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface Model {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface ModelsResponse {
  models: Model[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

export class OllamaError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'OllamaError';
  }
}

export class OllamaConnectionError extends OllamaError {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaConnectionError';
  }
}

export class OllamaAuthError extends OllamaError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'OllamaAuthError';
  }
}
