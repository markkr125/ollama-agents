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

/**
 * Ollama runtime parameters — controls model behaviour during inference.
 * All fields are optional; Ollama applies model-specific defaults when omitted.
 * See https://docs.ollama.com/api/generate#request-with-options
 */
export interface OllamaOptions {
  /** Context window size in tokens. When set, Ollama allocates this much KV-cache. */
  num_ctx?: number;
  /** Maximum number of tokens to generate in the response. */
  num_predict?: number;
  /** Sampling temperature (0 = deterministic, higher = more creative). */
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  /** Seed for deterministic generation. Same seed + same prompt = same output. */
  seed?: number;
  /** Penalise repeated tokens. Higher = less repetition. Default 1.1. */
  repeat_penalty?: number;
  /** How far back to look for repeated tokens. Default 64. */
  repeat_last_n?: number;
  /** Stop generation when any of these strings is encountered. */
  stop?: string[];
  /** Presence penalty (OpenAI-compatible). */
  presence_penalty?: number;
  /** Frequency penalty (OpenAI-compatible). */
  frequency_penalty?: number;
  /** Number of tokens to keep from the initial prompt when context is full. */
  num_keep?: number;
  /** Batch size for prompt evaluation. */
  num_batch?: number;
  /** Mirostat sampling mode (0 = disabled, 1 = Mirostat, 2 = Mirostat 2.0). */
  mirostat?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  tfs_z?: number;
  typical_p?: number;
  /** Number of GPU layers. -1 = all layers. */
  num_gpu?: number;
  num_thread?: number;
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: OllamaOptions;
  /** How long to keep the model loaded after the request (e.g. '30m', '1h'). Default '5m'. */
  keep_alive?: string | number;
  /** Force a specific output format: 'json' or a JSON schema object. */
  format?: string | object;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  options?: OllamaOptions;
  tools?: ToolDefinition[];
  /** Enable chain-of-thought reasoning (Ollama 0.6+). */
  think?: boolean;
  /** How long to keep the model loaded after the request (e.g. '30m', '1h'). Default '5m'. */
  keep_alive?: string | number;
  /** Force a specific output format: 'json' or a JSON schema object. */
  format?: string | object;
}

export interface StreamChunk {
  model?: string;
  response?: string;
  message?: ChatMessage;
  done: boolean;
  /** Reason the stream ended — 'stop' (normal), 'length' (truncated by context/token limit) */
  done_reason?: string;
  /** Error message from Ollama — emitted as an NDJSON line `{"error":"..."}` mid-stream or on failure. */
  error?: string;
  total_duration?: number;
  load_duration?: number;
  /** Number of tokens in the prompt (populated on the final chunk when done=true). */
  prompt_eval_count?: number;
  /** Duration of prompt evaluation in nanoseconds. */
  prompt_eval_duration?: number;
  /** Number of tokens generated in the response (populated on the final chunk). */
  eval_count?: number;
  /** Duration of response generation in nanoseconds. */
  eval_duration?: number;
}

// ---------------------------------------------------------------------------
// GET /api/ps — list running models
// ---------------------------------------------------------------------------

export interface RunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  expires_at?: string;
  size_vram?: number;
}

export interface RunningModelsResponse {
  models: RunningModel[];
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
  /** Raw Modelfile parameters string (e.g. "num_ctx 8192\ntemperature 0.7"). */
  parameters?: string;
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
