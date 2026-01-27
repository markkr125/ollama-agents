import { ChatMessage } from '../types/ollama';

export class HistoryManager {
  private conversations = new Map<string, ChatMessage[]>();

  /**
   * Add message to conversation history
   */
  addMessage(conversationId: string, message: ChatMessage): void {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, []);
    }

    this.conversations.get(conversationId)!.push(message);
  }

  /**
   * Get conversation history with sliding window
   * Keeps system message and truncates old messages to fit within character limit
   */
  getHistoryWithinLimit(
    conversationId: string,
    maxChars: number
  ): ChatMessage[] {
    const messages = this.conversations.get(conversationId) || [];
    
    if (messages.length === 0) {
      return [];
    }

    // Always keep system message if present
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    // Calculate character usage
    const systemChars = systemMessage ? systemMessage.content.length : 0;
    let availableChars = maxChars - systemChars;

    // Add messages from most recent, working backwards
    const selectedMessages: ChatMessage[] = [];
    for (let i = otherMessages.length - 1; i >= 0; i--) {
      const msg = otherMessages[i];
      const msgChars = msg.content.length;

      if (msgChars <= availableChars) {
        selectedMessages.unshift(msg);
        availableChars -= msgChars;
      } else {
        break; // Stop when we run out of space
      }
    }

    // Prepend system message if exists
    if (systemMessage) {
      selectedMessages.unshift(systemMessage);
    }

    return selectedMessages;
  }

  /**
   * Get full conversation history
   */
  getHistory(conversationId: string): ChatMessage[] {
    return this.conversations.get(conversationId) || [];
  }

  /**
   * Clear conversation history
   */
  clearHistory(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  /**
   * Clear all histories
   */
  clearAll(): void {
    this.conversations.clear();
  }
}
