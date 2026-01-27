import * as vscode from 'vscode';
import { getModeConfig } from '../config/settings';
import { HistoryManager } from '../services/historyManager';
import { OllamaClient } from '../services/ollamaClient';
import { ChatMessage } from '../types/ollama';

export class AskModeHandler {
  constructor(
    private client: OllamaClient,
    private historyManager: HistoryManager
  ) {}

  async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<{ metadata?: Record<string, any> }> {
    const config = getModeConfig('ask');

    // Check if model is configured
    if (!config.model) {
      stream.markdown('⚠️ No model configured for Ask mode. Please select a model using the command `Ollama Copilot: Select Model` or configure `ollamaCopilot.askMode.model` in settings.');
      return {};
    }

    // Get conversation ID from context
    const conversationId = context.history.length > 0 ? 'chat-session' : 'new-session';

    // Handle slash commands
    if (request.command) {
      return await this.handleCommand(request, stream, token, conversationId, config);
    }

    // Handle regular chat
    return await this.handleChat(request, context, stream, token, conversationId, config);
  }

  private async handleCommand(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    _conversationId: string,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    const command = request.command;
    const prompt = request.prompt;

    switch (command) {
      case 'explain':
        return await this.handleExplain(prompt, stream, token, config);
      case 'fix':
        return await this.handleFix(prompt, stream, token, config);
      case 'generate':
        return await this.handleGenerate(prompt, stream, token, config);
      case 'test':
        return await this.handleTest(prompt, stream, token, config);
      case 'refactor':
        return await this.handleRefactor(prompt, stream, token, config);
      case 'docs':
        return await this.handleDocs(prompt, stream, token, config);
      default:
        stream.markdown(`Unknown command: /${command}`);
        return {};
    }
  }

  private async handleChat(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    conversationId: string,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    // Build context from references (#file, #selection)
    let contextInfo = '';
    
    for (const ref of request.references) {
      if (ref.id === 'vscode.file' && 'uri' in (ref.value as any)) {
        const uri = (ref.value as any).uri as vscode.Uri;
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          contextInfo += `\n\n**File: ${uri.fsPath}**\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\`\n`;
        } catch (error) {
          contextInfo += `\n\n**File: ${uri.fsPath}** (Could not read file)\n`;
        }
      } else if (ref.id === 'vscode.selection') {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const selection = editor.selection;
          const text = editor.document.getText(selection);
          const languageId = editor.document.languageId;
          contextInfo += `\n\n**Selected code:**\n\`\`\`${languageId}\n${text}\n\`\`\`\n`;
        }
      }
    }

    // Build messages array
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Help the user with their coding questions. Provide clear, concise, and accurate answers. Use code examples when appropriate.'
      }
    ];

    // Add conversation history (with sliding window)
    const history = this.historyManager.getHistoryWithinLimit(conversationId, config.maxTokens * 3);
    messages.push(...history);

    // Add user message with context
    const userMessage = contextInfo 
      ? `${contextInfo}\n\n${request.prompt}`
      : request.prompt;

    messages.push({
      role: 'user',
      content: userMessage
    });

    // Save user message to history
    this.historyManager.addMessage(conversationId, {
      role: 'user',
      content: request.prompt
    });

    // Stream response
    let fullResponse = '';
    
    try {
      const chatStream = this.client.chat({
        model: config.model,
        messages,
        options: {
          temperature: config.temperature,
          num_predict: config.maxTokens
        }
      });

      for await (const chunk of chatStream) {
        if (token.isCancellationRequested) {
          break;
        }

        const content = chunk.message?.content || chunk.response || '';
        if (content) {
          fullResponse += content;
          stream.markdown(content);
        }

        if (chunk.done) {
          break;
        }
      }

      // Save assistant response to history
      if (fullResponse) {
        this.historyManager.addMessage(conversationId, {
          role: 'assistant',
          content: fullResponse
        });
      }

      return { metadata: { model: config.model } };

    } catch (error: any) {
      if (token.isCancellationRequested) {
        return {};
      }
      
      stream.markdown(`\n\n❌ Error: ${error.message}`);
      return {};
    }
  }

  private async handleExplain(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    const editor = vscode.window.activeTextEditor;
    let codeToExplain = '';

    if (editor && !editor.selection.isEmpty) {
      codeToExplain = editor.document.getText(editor.selection);
    } else if (prompt) {
      codeToExplain = prompt;
    }

    if (!codeToExplain) {
      stream.markdown('Please select code to explain or provide code in your message.');
      return {};
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Explain code clearly and thoroughly.'
      },
      {
        role: 'user',
        content: `Please explain this code:\n\`\`\`\n${codeToExplain}\n\`\`\``
      }
    ];

    return await this.streamResponse(messages, stream, token, config);
  }

  private async handleFix(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    const editor = vscode.window.activeTextEditor;
    let codeToFix = '';

    if (editor && !editor.selection.isEmpty) {
      codeToFix = editor.document.getText(editor.selection);
    } else if (prompt) {
      codeToFix = prompt;
    }

    if (!codeToFix) {
      stream.markdown('Please select code to fix or provide code in your message.');
      return {};
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Identify and fix issues in code.'
      },
      {
        role: 'user',
        content: `Please identify issues and provide fixed code:\n\`\`\`\n${codeToFix}\n\`\`\``
      }
    ];

    return await this.streamResponse(messages, stream, token, config);
  }

  private async handleGenerate(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    if (!prompt) {
      stream.markdown('Please describe what code you want to generate.');
      return {};
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Generate clean, well-documented code.'
      },
      {
        role: 'user',
        content: `Generate code for: ${prompt}`
      }
    ];

    return await this.streamResponse(messages, stream, token, config);
  }

  private async handleTest(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    const editor = vscode.window.activeTextEditor;
    let codeToTest = '';

    if (editor && !editor.selection.isEmpty) {
      codeToTest = editor.document.getText(editor.selection);
    } else if (prompt) {
      codeToTest = prompt;
    }

    if (!codeToTest) {
      stream.markdown('Please select code to test or provide code in your message.');
      return {};
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Generate comprehensive unit tests.'
      },
      {
        role: 'user',
        content: `Generate unit tests for this code:\n\`\`\`\n${codeToTest}\n\`\`\``
      }
    ];

    return await this.streamResponse(messages, stream, token, config);
  }

  private async handleRefactor(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    const editor = vscode.window.activeTextEditor;
    let codeToRefactor = '';

    if (editor && !editor.selection.isEmpty) {
      codeToRefactor = editor.document.getText(editor.selection);
    } else if (prompt) {
      codeToRefactor = prompt;
    }

    if (!codeToRefactor) {
      stream.markdown('Please select code to refactor or provide code in your message.');
      return {};
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Refactor code to improve quality, readability, and maintainability.'
      },
      {
        role: 'user',
        content: `Please refactor this code:\n\`\`\`\n${codeToRefactor}\n\`\`\``
      }
    ];

    return await this.streamResponse(messages, stream, token, config);
  }

  private async handleDocs(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    const editor = vscode.window.activeTextEditor;
    let codeToDocument = '';

    if (editor && !editor.selection.isEmpty) {
      codeToDocument = editor.document.getText(editor.selection);
    } else if (prompt) {
      codeToDocument = prompt;
    }

    if (!codeToDocument) {
      stream.markdown('Please select code to document or provide code in your message.');
      return {};
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Generate comprehensive documentation.'
      },
      {
        role: 'user',
        content: `Generate documentation for this code:\n\`\`\`\n${codeToDocument}\n\`\`\``
      }
    ];

    return await this.streamResponse(messages, stream, token, config);
  }

  private async streamResponse(
    messages: ChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    config: any
  ): Promise<{ metadata?: Record<string, any> }> {
    try {
      const chatStream = this.client.chat({
        model: config.model,
        messages,
        options: {
          temperature: config.temperature,
          num_predict: config.maxTokens
        }
      });

      for await (const chunk of chatStream) {
        if (token.isCancellationRequested) {
          break;
        }

        const content = chunk.message?.content || chunk.response || '';
        if (content) {
          stream.markdown(content);
        }

        if (chunk.done) {
          break;
        }
      }

      return { metadata: { model: config.model } };

    } catch (error: any) {
      if (token.isCancellationRequested) {
        return {};
      }
      
      stream.markdown(`\n\n❌ Error: ${error.message}`);
      return {};
    }
  }
}
