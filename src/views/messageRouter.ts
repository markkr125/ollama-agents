import { IMessageHandler } from './chatTypes';

/**
 * Routes incoming webview messages to the appropriate IMessageHandler.
 * Builds a type→handler lookup map at construction time for O(1) dispatch.
 */
export class MessageRouter {
  private readonly handlerMap = new Map<string, IMessageHandler>();

  constructor(handlers: IMessageHandler[]) {
    for (const handler of handlers) {
      for (const type of handler.handledTypes) {
        if (this.handlerMap.has(type)) {
          console.warn(`[MessageRouter] Duplicate handler for message type '${type}'`);
        }
        this.handlerMap.set(type, handler);
      }
    }
  }

  async route(data: any): Promise<void> {
    const handler = this.handlerMap.get(data.type);
    if (handler) {
      await handler.handle(data);
    } else {
      console.warn(`[MessageRouter] Unhandled message type: '${data.type}'`);
    }
  }
}
