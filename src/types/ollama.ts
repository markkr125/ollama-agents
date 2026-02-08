// Ollama API types

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool calls returned by the model when using native tool calling. */
  tool_calls?: ToolCall[];
  /** Name of the tool that produced this result (for role:'tool' messages). */
  tool_name?: string;
  /** Chain-of-thought reasoning returned when think=true. */
  thinking?: string;
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
  /** Enable chain-of-thought reasoning (Ollama 0.6+). */
  think?: boolean;
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
  /** Capabilities reported by the /api/show endpoint (e.g. "completion", "vision", "tools"). */
  capabilities?: string[];
  /** Whether the model is enabled for use in chat/agent/completion. Defaults to true. */
  enabled?: boolean;
}

export interface ModelsResponse {
  models: Model[];
}

/**
 * Response from POST /api/show.
 * Only the fields we care about are typed here.
 */
export interface ShowModelResponse {
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, any>;
  capabilities?: string[];
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
  /** Not returned by Ollama — present only in OpenAI-compatible APIs. */
  id?: string;
  /** Always "function" in Ollama responses. */
  type?: string;
  function: {
    /** Position index for parallel tool calls (Ollama includes this in responses). */
    index?: number;
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
