---
applyTo: "src/views/**,src/webview/**"
description: "Backend-to-frontend and frontend-to-backend message protocol for the chat webview"
---

# UI Component Communication

## Backend → Frontend Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `init` | `{models, currentMode, settings, hasToken}` | Initialize UI with settings and model list |
| `settingsUpdate` | `{settings, hasToken}` | Push updated settings to webview |
| `showThinking` | `{message, sessionId}` | Show loading state for a session |
| `hideThinking` | `{sessionId}` | Hide loading state for a session |
| `startProgressGroup` | `{title, sessionId}` | Start collapsible group |
| `showToolAction` | `{status, icon, text, detail, sessionId}` | Add/update action in group |
| `finishProgressGroup` | `{sessionId}` | Mark group complete |
| `requestToolApproval` | `{id, command, cwd, severity, reason, sessionId}` | Show terminal command approval card |
| `toolApprovalResult` | `{approvalId, status, output, command?, autoApproved?, sessionId}` | Update terminal command approval status |
| `requestFileEditApproval` | `{id, filePath, severity, reason, diffHtml, sessionId}` | Show file edit approval card with diff |
| `fileEditApprovalResult` | `{approvalId, status, autoApproved?, filePath, sessionId}` | Update file edit approval status |
| `sessionApprovalSettings` | `{sessionId, autoApproveCommands?, autoApproveSensitiveEdits?, sessionSensitiveFilePatterns?}` | Push per-session approval toggles |
| `streamChunk` | `{content, model?, sessionId}` | Stream assistant response (accumulated, not delta) |
| `finalMessage` | `{content, model?, sessionId}` | Finalize response scoped to a session |
| `generationStarted` | `{sessionId}` | Mark session as generating |
| `generationStopped` | `{sessionId}` | Mark session as stopped |
| `addMessage` | `{message, sessionId}` | Append a message in a specific session |
| `loadSessionMessages` | `{messages, sessionId, autoApproveCommands, autoApproveSensitiveEdits, sessionSensitiveFilePatterns}` | Load messages + approval settings for a session |
| `clearMessages` | `{sessionId}` | Clear all messages for a session |
| `showError` | `{message, sessionId}` | Show error message in session |
| `connectionError` | `{error}` | Show connection error (non-session-scoped) |
| `addContextItem` | `{context: {fileName, content}}` | Add code context from editor selection |
| `loadSessions` | `{sessions, hasMore, nextOffset}` | Replace sessions list |
| `appendSessions` | `{sessions, hasMore, nextOffset}` | Append to sessions list |
| `updateSessionStatus` | `{sessionId, status}` | Update a single session's status indicator |
| `sessionDeleted` | `{sessionId}` | Confirm single session deleted |
| `sessionsDeleted` | `{sessionIds}` | Confirm batch session deletion (empty array = cancelled) |
| `deletionProgress` | `{completed, total}` | Batch deletion progress (10+ sessions) |
| `searchSessionsResult` | `{results, query, error?}` | Return session search results |
| `dbMaintenanceResult` | `{success, deletedSessions?, deletedMessages?, message?}` | Maintenance result |
| `recreateMessagesResult` | `{success, message?}` | Messages table recreation result |
| `connectionTestResult` | `{success, message}` | Connection test result |
| `bearerTokenSaved` | `{hasToken}` | Token save confirmation |
| `navigateToSettings` | `{isFirstRun}` | Navigate webview to settings page (first-run or manual) |

## Frontend → Backend Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `ready` | `{sessionId?}` | UI initialized (triggers `init` response, optionally restores session) |
| `sendMessage` | `{text, context}` | User message |
| `stopGeneration` | `{sessionId}` | Cancel generation for a session |
| `selectMode` | `{mode}` | Change mode |
| `selectModel` | `{model}` | Change model |
| `newChat` | - | Create new session (reuses idle empty session if one exists) |
| `addContext` | - | Request code context from active editor selection |
| `loadSession` | `{sessionId}` | Load session |
| `deleteSession` | `{sessionId}` | Delete session (optimistic removal on frontend) |
| `deleteMultipleSessions` | `{sessionIds}` | Batch delete with modal confirmation |
| `searchSessions` | `{query}` | Search sessions by content |
| `saveSettings` | `{settings}` | Save settings |
| `testConnection` | `{baseUrl?}` | Test server connection (optionally apply URL first) |
| `saveBearerToken` | `{token, testAfterSave?, baseUrl?}` | Save bearer token (optionally test after) |
| `loadMoreSessions` | `{offset}` | Load more sessions (pagination) |
| `runDbMaintenance` | - | Run DB maintenance cleanup |
| `recreateMessagesTable` | - | Recreate LanceDB messages table |
| `toolApprovalResponse` | `{approvalId, approved, command?}` | Respond to terminal command approval |
| `setAutoApprove` | `{sessionId, enabled}` | Toggle auto-approve commands for session |
| `setAutoApproveSensitiveEdits` | `{sessionId, enabled}` | Toggle auto-approve sensitive edits for session |
| `updateSessionSensitivePatterns` | `{sessionId, patterns}` | Update session-level sensitive file patterns |
| `openFileDiff` | `{approvalId}` | Open file diff in VS Code editor |

## Session-Concurrent Streaming

- Streaming, tool actions, and progress updates are routed with `sessionId`.
- The webview ignores updates that do not match the currently active session.
- Background sessions continue generating; switching sessions does not stop generation.
- The Stop button sends `stopGeneration` with the active `sessionId`.

## Chat View Backend Structure

Keep `src/views/chatView.ts` small and focused. Use these files for specific concerns:

- **`src/views/chatView.ts`**
  - Webview lifecycle + routing only
  - Implements `WebviewMessageEmitter`
  - Delegates to services/controllers

- **`src/views/chatSessionController.ts`**
  - Session creation/loading/deletion
  - Session list + search + status updates
  - Current session state + message cache

- **`src/views/settingsHandler.ts`**
  - Read/save settings
  - Test connection + token handling
  - DB maintenance actions

- **`src/services/agentChatExecutor.ts`**
  - Agent execution loop
  - Tool call parsing + execution
  - Progress group + tool UI updates (via emitter)

- **`src/views/toolUIFormatter.ts`**
  - Pure helpers mapping tool calls/results → UI text/icons

- **`src/views/chatTypes.ts`**
  - Shared view types
  - `WebviewMessageEmitter` interface

**Rule:** Do not re-bloat `chatView.ts`. If a method exceeds ~50 lines or handles a distinct concern, extract it into one of the modules above.

## Streaming Behavior

The backend sends **accumulated content** with each stream chunk, not incremental deltas:

```typescript
// Backend sends: "Hello", then "Hello World", then "Hello World!"
// NOT: "Hello", then " World", then "!"
handleStreamChunk({ content: 'Hello World!' }); // replaces, not appends
```

The `handleStreamChunk` handler **replaces** the text block content, it does not append.
