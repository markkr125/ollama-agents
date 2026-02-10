---
name: add-chat-message-type
description: "Step-by-step guide for adding a new message type to the backend-frontend communication protocol. Use when asked to add a new postMessage type, webview message handler, or backend-to-frontend event."
---

# Adding a New Chat Message Type

The extension uses `postMessage` / `onDidReceiveMessage` for all backend↔frontend communication. Adding a new message type requires changes in 3–5 files depending on direction.

## Backend → Frontend Message

When the extension backend needs to send a new event to the webview.

### Step 1: Send from Backend

In the appropriate backend file, post the message via the emitter:

```typescript
this.emitter.postMessage({
  type: 'myNewEvent',
  someData: value,
  sessionId  // include if session-scoped
});
```

**Where to send from:**
| Concern | File |
|---------|------|
| Agent tool execution / progress | `src/services/agent/agentChatExecutor.ts` (orchestrator) + `src/services/agent/agentToolRunner.ts` (tool batch execution) |
| Session state / list updates | `src/views/chatSessionController.ts` |
| Settings / connection / DB ops | `src/views/settingsHandler.ts` |
| Chat/agent mode dispatch | `src/views/messageHandlers/chatMessageHandler.ts` |

### Step 2: Add Type Interface (optional but recommended)

In `src/webview/scripts/core/types.ts`, add a typed interface:

```typescript
export interface MyNewEventMessage {
  type: 'myNewEvent';
  someData: string;
  sessionId?: string;
}
```

### Step 3: Create the Handler

Add the handler function in the appropriate file under `src/webview/scripts/core/messageHandlers/`:

| Message Category | Handler File |
|-----------------|-------------|
| Streaming / assistant text | `streaming.ts` |
| Progress groups / tool actions / errors | `progress.ts` |
| Approvals (tool, file edit) | `approvals.ts` |
| Sessions, settings, init, navigation | `sessions.ts` |
| New concern? | Create a new file |

```typescript
// In the appropriate handler file:
export function handleMyNewEvent(msg: MyNewEventMessage) {
  // Session-scoped? Guard early:
  if (msg.sessionId && msg.sessionId !== currentSessionId.value) return;

  // Update reactive state...
}
```

### Step 4: Register in Router

In `src/webview/scripts/core/messageHandlers/index.ts`:

1. Import the handler at the top
2. Add a `case` in the `handleMessage` switch:

```typescript
case 'myNewEvent':
  handleMyNewEvent(msg as MyNewEventMessage);
  break;
```

### Step 5: Persist (if needed for session history)

If this event must appear when loading a session from history, persist it as a `__ui__` event in `agentChatExecutor.ts` **before** posting:

```typescript
await this.persistUiEvent(sessionId, 'myNewEvent', { someData: value });
this.emitter.postMessage({ type: 'myNewEvent', someData: value, sessionId });
```

Then add a handler in `src/webview/scripts/core/timelineBuilder.ts` to reconstruct the UI from the persisted event during session load.

---

## Frontend → Backend Message

When the webview needs to send an action to the extension backend.

### Step 1: Send from Webview

Use the VS Code API stub:

```typescript
vscode.postMessage({ type: 'myAction', payload: value });
```

Typically called from an action function in `src/webview/scripts/core/actions/`.

### Step 2: Handle in Backend via IMessageHandler

The backend uses a `MessageRouter` that dispatches messages to `IMessageHandler` classes. Add your message type to the appropriate handler in `src/views/messageHandlers/`:

| Concern | Handler File |
|---------|-------------|
| Chat / agent mode / model selection | `chatMessageHandler.ts` |
| Session load / delete / search | `sessionMessageHandler.ts` |
| Settings / connection / DB | `settingsMessageHandler.ts` |
| Tool / file approvals | `approvalMessageHandler.ts` |
| Keep / undo / diff stats | `fileChangeMessageHandler.ts` |
| Model capabilities / toggle | `modelMessageHandler.ts` |
| Inline review navigation | `reviewNavMessageHandler.ts` |
| New concern? | Create a new `IMessageHandler` class |

1. Add the message type string to the handler's `handledTypes` array
2. Add a case in the handler's `handle(data)` method:

```typescript
class MyHandler implements IMessageHandler {
  readonly handledTypes = ['existingType', 'myAction'] as const;

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'myAction':
        await this.handleMyAction(data.payload);
        break;
    }
  }
}
```

**Keep the handler focused** — if it doesn't fit an existing handler's concern, create a new `IMessageHandler` class, register it in `chatView.ts`'s constructor, and add it to the `MessageRouter`.

### Step 3: Add Action Function (if triggered by UI)

Add the action in `src/webview/scripts/core/actions/` (new file or existing file by concern), then export from `actions/index.ts`.

---

## Session-Scoped Messages

Most messages include a `sessionId` field. The webview **ignores messages that don't match the active session**. This enables concurrent background generation.

**Backend pattern:**
```typescript
this.emitter.postMessage({ type: 'myEvent', data, sessionId });
```

**Frontend guard:**
```typescript
if (msg.sessionId && msg.sessionId !== currentSessionId.value) return;
```

---

## Checklist

**Backend → Frontend:**
- [ ] `postMessage()` call in the appropriate backend file
- [ ] Type interface in `src/webview/scripts/core/types.ts`
- [ ] Handler function in `src/webview/scripts/core/messageHandlers/<concern>.ts`
- [ ] Case in `messageHandlers/index.ts` router switch
- [ ] Session guard (if session-scoped)
- [ ] `persistUiEvent` + `timelineBuilder` handler (if must survive session reload)
- [ ] Update `ui-messages.instructions.md` protocol table
- [ ] `npm run lint:all` passes

**Frontend → Backend:**
- [ ] `vscode.postMessage()` call (in action function or component)
- [ ] Handler in appropriate `src/views/messageHandlers/*.ts` class (add to `handledTypes` + `handle()` switch)
- [ ] Delegate to appropriate service (keep handlers focused)
- [ ] Update `ui-messages.instructions.md` protocol table
- [ ] `npm run lint:all` passes
