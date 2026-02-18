import {
    ChatRequest,
    GenerateRequest,
    Model,
    ModelsResponse,
    OllamaAuthError,
    OllamaConnectionError,
    OllamaError,
    RunningModelsResponse,
    ShowModelResponse,
    StreamChunk
} from '../../types/ollama';
import { parseNDJSON } from '../../utils/streamParser';
import { extractContextLength } from '../model/modelCompatibility';

export class OllamaClient {
  private baseUrl: string;
  private bearerToken?: string;
  private retryAttempts = 3;
  private retryDelays = [1000, 2000, 4000]; // Exponential backoff

  constructor(baseUrl: string, bearerToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.bearerToken = bearerToken;
  }

  /**
   * Update bearer token (useful when token changes)
   */
  public setBearerToken(token: string | undefined): void {
    this.bearerToken = token;
  }

  /**
   * Update base URL (useful when settings change)
   */
  public setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Get headers with optional bearer token
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    return headers;
  }

  /**
   * Retry logic wrapper
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attempt = 0
  ): Promise<Response> {
    try {
      const response = await fetch(url, options);

      if (response.status === 401) {
        throw new OllamaAuthError('Invalid bearer token. Please check your OpenWebUI credentials.');
      }

      if (!response.ok && response.status >= 500) {
        // Try to extract Ollama's error message from the response body
        let detail = '';
        try {
          const text = await response.text();
          try {
            const body = JSON.parse(text);
            if (body?.error) detail = `: ${body.error}`;
          } catch {
            // Not JSON — use the raw text (trimmed, capped)
            if (text.trim()) detail = `: ${text.trim().substring(0, 500)}`;
          }
        } catch { /* completely unreadable body */ }
        if (!detail) {
          detail = ' (empty response body — this usually means the model crashed, ran out of memory, or failed to load)';
        }
        throw new OllamaError(`Server error: ${response.status} ${response.statusText}${detail}`, response.status);
      }

      return response;
    } catch (error: any) {
      if (error instanceof OllamaAuthError) {
        throw error;
      }

      // Never retry an intentional abort (user clicked Stop)
      if (error.name === 'AbortError') {
        throw error;
      }

      if (attempt < this.retryAttempts - 1) {
        const delay = this.retryDelays[attempt];
        console.log(`Retry attempt ${attempt + 1}/${this.retryAttempts} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, attempt + 1);
      }

      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        throw new OllamaConnectionError(`Failed to connect to Ollama at ${this.baseUrl}. Is it running?`);
      }

      throw error;
    }
  }

  /**
   * Stream chat completions
   */
  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const url = `${this.baseUrl}/api/chat`;
    const body = { ...request, stream: true };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      throw new OllamaError(`Chat request failed: ${response.statusText}`, response.status);
    }

    if (!response.body) {
      throw new OllamaError('No response body received');
    }

    const reader = response.body.getReader();
    
    for await (const chunk of parseNDJSON(reader)) {
      yield chunk as StreamChunk;
    }
  }

  /**
   * Non-streaming chat completion. Returns the full response object.
   * Used for fast, short classification calls (e.g. intent dispatcher).
   */
  async chatNoStream(request: { model: string; messages: Array<{ role: string; content: string }>; options?: any; stream?: false }): Promise<any> {
    const url = `${this.baseUrl}/api/chat`;
    const body = { ...request, stream: false };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new OllamaError(`Chat request failed: ${response.statusText}`, response.status);
    }

    return response.json();
  }

  /**
   * Stream generate completions
   */
  async *generate(request: GenerateRequest): AsyncGenerator<StreamChunk> {
    const url = `${this.baseUrl}/api/generate`;
    const body = { ...request, stream: true };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new OllamaError(`Generate request failed: ${response.statusText}`, response.status);
    }

    if (!response.body) {
      throw new OllamaError('No response body received');
    }

    const reader = response.body.getReader();
    
    for await (const chunk of parseNDJSON(reader)) {
      yield chunk as StreamChunk;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<Model[]> {
    const url = `${this.baseUrl}/api/tags`;

    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new OllamaError(`Failed to list models: ${response.statusText}`, response.status);
    }

    const data = await response.json() as ModelsResponse;
    return data.models || [];
  }

  /**
   * Show model information including capabilities.
   * Calls POST /api/show with { model: name }.
   */
  async showModel(name: string): Promise<ShowModelResponse> {
    const url = `${this.baseUrl}/api/show`;

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ model: name })
    });

    if (!response.ok) {
      throw new OllamaError(`Show model failed for ${name}: ${response.statusText}`, response.status);
    }

    return await response.json() as ShowModelResponse;
  }

  /**
   * Fetch all models and enrich each with capabilities from /api/show.
   * Calls listModels() then showModel() in parallel for each model.
   */
  async fetchModelsWithCapabilities(): Promise<Model[]> {
    const models = await this.listModels();

    // Call /api/show in parallel for all models to get capabilities
    const showResults = await Promise.allSettled(
      models.map(m => this.showModel(m.name))
    );

    for (let i = 0; i < models.length; i++) {
      const result = showResults[i];
      if (result.status === 'fulfilled') {
        const show = result.value;
        if (show.capabilities) {
          models[i].capabilities = show.capabilities;
        }
        const ctxLen = extractContextLength(show);
        if (ctxLen) {
          (models[i] as any).contextLength = ctxLen;
        }
      }
    }

    return models;
  }

  /**
   * List currently running/loaded models.
   * Calls GET /api/ps — useful for checking if a model is already loaded
   * and what effective context length it has.
   */
  async getRunningModels(): Promise<RunningModelsResponse> {
    const url = `${this.baseUrl}/api/ps`;

    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new OllamaError(`Failed to list running models: ${response.statusText}`, response.status);
    }

    return await response.json() as RunningModelsResponse;
  }

  /**
   * Test connection to Ollama/OpenWebUI
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    // Cleanup if needed
  }
}
