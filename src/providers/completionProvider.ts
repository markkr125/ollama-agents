import * as vscode from 'vscode';
import { extractContext } from '../services/contextBuilder';
import { OllamaClient } from '../services/model/ollamaClient';
import { getFIMPrompt, hasFIMSupport } from '../templates/fimTemplates';
import { ModeConfig } from '../types/config';

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastCompletionTime = 0;

  constructor(
    private client: OllamaClient,
    private config: ModeConfig
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined> {
    
    // Skip if no model configured
    if (!this.config.model) {
      return null;
    }

    // Check if model supports FIM
    if (!hasFIMSupport(this.config.model)) {
      // Only warn once per session
      if (Date.now() - this.lastCompletionTime > 60000) {
        vscode.window.showWarningMessage(
          `Model '${this.config.model}' may not support code completion. Consider using a code-specific model.`,
          'Select Model'
        ).then(choice => {
          if (choice === 'Select Model') {
            vscode.commands.executeCommand('ollamaCopilot.selectModel');
          }
        });
      }
    }

    this.lastCompletionTime = Date.now();

    try {
      // Extract code context
      const { prefix, suffix, languageId } = extractContext(document, position);

      // Build FIM prompt
      const prompt = getFIMPrompt(prefix, suffix, this.config.model, languageId);

      // Generate completion
      const completion = await this.generateCompletion(prompt, token);

      if (!completion) {
        return null;
      }

      // Create inline completion item
      const item = new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position)
      );

      return [item];

    } catch (error: any) {
      if (error.name === 'AbortError' || token.isCancellationRequested) {
        return null;
      }

      console.error('Completion error:', error);
      return null;
    }
  }

  private async generateCompletion(
    prompt: string,
    token: vscode.CancellationToken
  ): Promise<string | null> {
    let completion = '';
    let aborted = false;

    // Set up cancellation
    const abortHandler = () => {
      aborted = true;
    };
    token.onCancellationRequested(abortHandler);

    try {
      const stream = this.client.generate({
        model: this.config.model,
        prompt,
        options: {
          temperature: this.config.temperature,
          num_predict: this.config.maxTokens
        }
      });

      for await (const chunk of stream) {
        if (aborted || token.isCancellationRequested) {
          return null;
        }

        if (chunk.response) {
          completion += chunk.response;
        }

        if (chunk.done) {
          break;
        }
      }

      // Clean up completion
      completion = this.cleanCompletion(completion);

      return completion || null;

    } catch (error: any) {
      if (aborted || token.isCancellationRequested) {
        return null;
      }
      throw error;
    }
  }

  private cleanCompletion(text: string): string {
    // Remove any FIM special tokens that might have leaked through
    text = text.replace(/<\|fim_.*?\|>/g, '');
    text = text.replace(/<PRE>|<SUF>|<MID>/g, '');
    text = text.replace(/<fim_prefix>|<fim_suffix>|<fim_middle>/g, '');
    text = text.replace(/<｜fim▁.*?｜>/g, '');

    // Trim whitespace
    text = text.trimEnd();

    return text;
  }

  public updateConfig(config: ModeConfig): void {
    this.config = config;
  }
}
