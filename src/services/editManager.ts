import * as vscode from 'vscode';
import { OllamaClient } from '../services/ollamaClient';
import { ChatMessage } from '../types/ollama';
import { cleanResponseText, parseEditResponse } from '../utils/diffParser';

export class EditManager {
  constructor(private client: OllamaClient) {}

  /**
   * Generate code edit based on instructions
   */
  async generateEdit(
    code: string,
    instructions: string,
    languageId: string,
    model: string,
    temperature: number,
    maxTokens: number
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert code editor. Modify code according to user instructions. Return ONLY the modified code without explanations. Preserve formatting and style.'
      },
      {
        role: 'user',
        content: `Language: ${languageId}\n\nOriginal code:\n\`\`\`${languageId}\n${code}\n\`\`\`\n\nInstructions: ${instructions}\n\nProvide the modified code:`
      }
    ];

    let fullResponse = '';

    const stream = this.client.chat({
      model,
      messages,
      options: {
        temperature,
        num_predict: maxTokens
      }
    });

    for await (const chunk of stream) {
      const content = chunk.message?.content || chunk.response || '';
      if (content) {
        fullResponse += content;
      }

      if (chunk.done) {
        break;
      }
    }

    // Clean and parse the response
    fullResponse = cleanResponseText(fullResponse);
    const parsed = parseEditResponse(fullResponse, code, languageId);

    return parsed.content;
  }

  /**
   * Create diff preview URIs
   */
  createDiffPreviewUris(
    originalUri: vscode.Uri,
    _originalContent: string,
    _modifiedContent: string
  ): { originalUri: vscode.Uri; modifiedUri: vscode.Uri } {
    // Create virtual document URIs for diff view
    const originalDiffUri = vscode.Uri.parse(
      `ollama-copilot-diff:${originalUri.fsPath}?original`
    );
    const modifiedDiffUri = vscode.Uri.parse(
      `ollama-copilot-diff:${originalUri.fsPath}?modified`
    );

    return {
      originalUri: originalDiffUri,
      modifiedUri: modifiedDiffUri
    };
  }

  /**
   * Show diff in editor
   */
  async showDiff(
    originalUri: vscode.Uri,
    originalContent: string,
    modifiedContent: string,
    title: string = 'Code Changes'
  ): Promise<void> {
    // Register content provider for diff documents
    const provider = new DiffContentProvider(originalContent, modifiedContent);
    const providerDisposable = vscode.workspace.registerTextDocumentContentProvider(
      'ollama-copilot-diff',
      provider
    );

    try {
      const { originalUri: origDiffUri, modifiedUri: modDiffUri } = this.createDiffPreviewUris(
        originalUri,
        originalContent,
        modifiedContent
      );

      // Show diff
      await vscode.commands.executeCommand(
        'vscode.diff',
        origDiffUri,
        modDiffUri,
        title
      );
    } finally {
      // Clean up provider after a delay (to allow diff to render)
      setTimeout(() => providerDisposable.dispose(), 5000);
    }
  }

  /**
   * Apply edit to document
   */
  async applyEdit(
    document: vscode.TextDocument,
    newContent: string,
    range?: vscode.Range
  ): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();

    if (range) {
      edit.replace(document.uri, range, newContent);
    } else {
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      edit.replace(document.uri, fullRange, newContent);
    }

    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      await document.save();
    }

    return success;
  }
}

/**
 * Content provider for diff documents
 */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private originalContent: string,
    private modifiedContent: string
  ) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const query = uri.query;
    if (query === 'original') {
      return this.originalContent;
    } else if (query === 'modified') {
      return this.modifiedContent;
    }
    return '';
  }
}
