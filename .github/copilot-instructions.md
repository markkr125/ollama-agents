# Ollama Copilot - Project Instructions

---

## ⚠️ CRITICAL RULE #1: UI Event Ordering & Persistence

**Session history MUST be identical to live chat.** When a user loads a session from history, they must see the EXACT same timeline as when the chat was live. This is non-negotiable.

### The Golden Rule

**Every UI event that is `postMessage`'d to the webview MUST also be `persistUiEvent`'d to the database, IN THE SAME ORDER.**

```typescript
// CORRECT: Persist FIRST, then post (or at least in same logical order)
await this.persistUiEvent(sessionId, 'showToolAction', { status: 'pending', ... });
this.emitter.postMessage({ type: 'showToolAction', status: 'pending', ..., sessionId });

// WRONG: Post without persisting - history will be missing this event!
this.emitter.postMessage({ type: 'showToolAction', status: 'pending', ..., sessionId });
// (no persistUiEvent call)
```

### Events That Must Be Persisted (In Order)

| Event Type | When | Payload |
|------------|------|---------|
| `startProgressGroup` | Before first tool in a group | `{ title, groupId }` |
| `showToolAction` (pending) | Before approval card (if any) | `{ status: 'pending', icon, text, detail }` |
| `requestToolApproval` | Terminal command needs approval | `{ id, command, cwd, severity, reason }` |
| `requestFileEditApproval` | File edit needs approval | `{ id, filePath, severity, reason, diffHtml }` |
| `toolApprovalResult` | After terminal approval resolved | `{ approvalId, status, output, autoApproved? }` |
| `fileEditApprovalResult` | After file edit approval resolved | `{ approvalId, status, autoApproved?, filePath }` |
| `showToolAction` (success/error) | After tool execution completes | `{ status: 'success'/'error', icon, text, detail }` |
| `finishProgressGroup` | After all tools in group complete | `{}` |

### Debugging Live vs History Mismatch

If live chat shows something that session history doesn't:
1. **Check if the event is being persisted** - search for `persistUiEvent` near the `postMessage` call
2. **Check the order** - events must be persisted in the same order they're posted
3. **Check timelineBuilder.ts** - the handler for that `eventType` must reconstruct the UI correctly

### Important Handler Rules

1. **Approval result handlers must NOT complete progress groups** - `handleFileEditApprovalResult` and `handleToolApprovalResult` should only update the approval card status. The `showToolAction(success)` and `finishProgressGroup` events are responsible for completing the action and group respectively.

2. **showToolAction with same text should update, not push** - When a `pending` action exists and a `running` action arrives with the same text, it should update the existing action in place, not push a new one.

3. **Success actions should find the last running/pending action** - When `showToolAction(success)` arrives with different text than the running action, use the fallback "last running/pending" search to find and update the correct action.

---

## Project Overview

**Ollama Copilot** is a VS Code extension that provides GitHub Copilot-like AI assistance using local Ollama or OpenWebUI as the backend. It's designed to be a fully local, privacy-preserving alternative to cloud-based AI coding assistants.

### Key Features
- **Inline Code Completion** - Autocomplete suggestions as you type
- **Chat Interface** - GitHub Copilot-style sidebar chat with multiple modes
- **Agent Mode** - Autonomous coding agent that can read/write files, search, and run commands
- **Edit Mode** - Apply AI-guided edits to selected code
- **Plan Mode** - Generate multi-step implementation plans
- **Ask Mode** - General Q&A about code

---

## Architecture

```
src/
├── extension.ts          # Main entry point, registers all providers
├── agent/                # Agent-related functionality
│   ├── executor.ts       # Executes agent plans
│   ├── gitOperations.ts  # Git branch/commit operations
│   ├── prWorkflow.ts     # PR creation workflow
│   ├── sessionManager.ts # Manages agent sessions
│   ├── sessionViewer.ts  # Tree view for sessions
│   ├── taskTracker.ts    # Tracks planned tasks
│   └── toolRegistry.ts   # Tool definitions for agent
├── config/
│   └── settings.ts       # Configuration helpers
├── modes/                # Different interaction modes
│   ├── agentMode.ts      # Autonomous agent commands
│   ├── editMode.ts       # Code editing with AI
│   └── planMode.ts       # Multi-step planning
├── providers/
│   └── completionProvider.ts  # Inline completion provider
├── services/             # Core services
│   ├── contextBuilder.ts # Builds context for prompts
│   ├── editManager.ts    # Manages edit operations
│   ├── historyManager.ts # Conversation history
│   ├── agentChatExecutor.ts # Agent chat execution loop + tool handling
│   ├── modelCompatibility.ts # Model feature detection
│   ├── modelManager.ts   # Model listing/selection
│   ├── ollamaClient.ts   # Ollama API client
│   ├── sessionIndexService.ts # SQLite-backed chat session index
│   └── tokenManager.ts   # Bearer token management
├── views/
│   ├── chatView.ts       # Webview provider (thin orchestration)
│   ├── chatSessionController.ts # Session state + messages + list/search
│   ├── settingsHandler.ts # Settings + token + connection handling
│   ├── toolUIFormatter.ts # Pure mapping for tool UI text/icons
│   └── chatTypes.ts       # Shared view types + WebviewMessageEmitter
├── webview/
│   ├── App.vue            # Vue root SFC (composes child components)
│   ├── main.ts            # Webview bootstrap
│   ├── index.html         # Webview HTML entry
│   ├── components/        # Vue UI subcomponents
│   │   ├── ChatPage.vue
│   │   ├── HeaderBar.vue
│   │   ├── SessionsPanel.vue
│   │   └── SettingsPage.vue
│   ├── scripts/           # Webview app logic split by concern
│   │   ├── app/
│   │   │   └── App.ts      # Entry/wiring for message handling
│   │   └── core/
│   │       ├── actions/    # UI actions split by concern (+ index.ts barrel)
│   │       ├── messageHandlers/ # Webview message handlers split by concern
│   │       ├── timelineBuilder.ts # Rebuild timeline from stored messages
│   │       ├── computed.ts # Derived state
│   │       ├── state.ts    # Reactive state/refs
│   │       └── types.ts    # Shared types
│   ├── styles/            # SCSS entry + partials
│   │   ├── styles.scss
│   │   ├── base/
│   │   ├── components/
│   │   ├── layout/
│   │   └── utils/
│   ├── setupWizard.ts     # First-run setup wizard
│   └── vite.config.ts     # Vite build for webview
├── templates/            # Prompt templates
├── types/                # TypeScript type definitions
│   └── session.ts         # Shared chat + agent session types
└── utils/                # Utility functions
```

---

## Core Components

### 1. OllamaClient (`src/services/ollamaClient.ts`)

The HTTP client for communicating with Ollama/OpenWebUI APIs.

**Key Methods:**
- `chat(request)` - Streaming chat completion (returns async generator)
- `generate(request)` - Non-chat text generation
- `listModels()` - Get available models
- `testConnection()` - Verify server connectivity

**Configuration:**
- Supports both Ollama (`http://localhost:11434`) and OpenWebUI
- Bearer token authentication for OpenWebUI
- Automatic retry with exponential backoff

### 2. ChatViewProvider (`src/views/chatView.ts`)

The main sidebar chat interface provider. It is intentionally **thin** and only handles:
- Webview lifecycle + message routing
- Mode dispatch (`agent` vs `chat/edit`)
- Delegation to helper services

The UI is built with Vue via Vite and emitted to `media/index.html`, `media/chatView.js`, and `media/chatView.css`.

**Features:**
- **Multiple Modes**: Agent, Ask, Edit (selectable via dropdown)
- **Sessions Management**: Create, switch, delete chat sessions
- **Settings Page**: Continue.dev-style settings with navigation sidebar
- **Progress Groups**: Copilot-style collapsible action groups
- **Advanced DB Maintenance**: Manual cleanup of session/message orphans

**UI Structure:**
```
┌─────────────────────────────────┐
│ ← Copilot          ➕ ⚙️ 📋    │ <- Header with back, new chat, settings, sessions
├─────────────────────────────────┤
│                                 │
│  How can I help you today?      │ <- Empty state or messages
│                                 │
│  ▼ Analyzing code               │ <- Collapsible progress group
│    ✓ Read file.ts, 50 lines     │ <- Individual actions
│    ⟳ Writing to output.ts      │
│                                 │
├─────────────────────────────────┤
│ 📎 Add context                  │ <- Context chips
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ Ask a question...           │ │ <- Input textarea
│ └─────────────────────────────┘ │
│ Agent ▼  model-name ▼    Send   │ <- Mode/model selectors
└─────────────────────────────────┘
```

**Message Flow:**
1. User types message → `sendMessage` event
2. Backend receives via `onDidReceiveMessage`
3. `ChatViewProvider` dispatches to:
  - `ChatSessionController` (session state/messages)
  - `SettingsHandler` (settings/token/connection)
  - `AgentChatExecutor` (agent loop + tools)
4. Responses are posted via a `WebviewMessageEmitter` interface
5. Frontend updates UI with `streamChunk`, `showToolAction`, etc.

### 3. ToolRegistry (`src/agent/toolRegistry.ts`)

Defines tools available to the agent for autonomous operations.

**Built-in Tools:**
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write content to file |
| `create_file` | Create new file |
| `list_files` | List directory contents |
| `search_workspace` | Search for text in files |
| `run_terminal_command` | Execute shell commands |
| `get_diagnostics` | Get file errors/warnings |

**Tool Call Format (in LLM responses):**
```xml
<tool_call>{"name": "read_file", "arguments": {"path": "src/file.ts"}}</tool_call>
```

### 3.1 Tool Call Parser (`src/utils/toolCallParser.ts`)

Parses tool calls from LLM responses. This is critical for agent functionality and must handle various LLM output quirks robustly.

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `extractToolCalls(response)` | Parse all tool calls from response text |
| `detectPartialToolCall(response)` | Detect in-progress tool call during streaming |
| `removeToolCalls(response)` | Strip tool call markup for display |

**Robustness Features:**

The parser handles various LLM quirks that smaller models (like devstral-small) may produce:

1. **Balanced JSON Extraction** - Uses brace counting instead of regex to properly extract nested JSON:
   ```typescript
   // WRONG: /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/  (stops at first })
   // RIGHT: extractBalancedJson() counts { and } to find matching close
   ```

2. **Multiple Argument Field Names** - Accepts `arguments`, `args`, `params`, or `parameters`:
   ```json
   {"name": "read_file", "args": {"path": "file.ts"}}  // works
   {"name": "read_file", "arguments": {"path": "file.ts"}}  // works
   ```

3. **Top-Level Arguments** - Accepts args at root level instead of nested:
   ```json
   {"name": "read_file", "path": "file.ts"}  // works (path extracted from top level)
   ```

4. **Multiple Tool Name Fields** - Accepts `name`, `tool`, or `function`:
   ```json
   {"tool": "read_file", "arguments": {"path": "file.ts"}}  // works
   ```

5. **Incomplete Tool Calls** - Handles LLM getting cut off mid-response:
   ```xml
   <tool_call>{"name": "write_file", "arguments": {"path": "x.ts", "content": "...
   ```
   The parser attempts to repair by adding missing closing braces.

**Tool Argument Flexibility:**

Tools in `toolRegistry.ts` also accept multiple argument names for the file path:
- `path`, `file`, or `filePath` are all valid for `read_file`, `write_file`, `get_diagnostics`

**Write Validation:**

The agent executor tracks whether a task requires file writes (based on keywords like "rename", "modify", "create", etc.) and validates that `write_file` was actually called before accepting `[TASK_COMPLETE]`. This prevents the LLM from hallucinating task completion.

### 4. Settings Configuration

Settings are defined in `package.json` under `contributes.configuration`:

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.baseUrl` | `http://localhost:11434` | Ollama server URL |
| `ollamaCopilot.completionMode.model` | `""` | Model for inline completions |
| `ollamaCopilot.agentMode.model` | `""` | Model for agent tasks |
| `ollamaCopilot.agent.maxIterations` | `25` | Max tool execution cycles |
| `ollamaCopilot.agent.toolTimeout` | `30000` | Tool timeout in ms |
| `ollamaCopilot.agent.maxActiveSessions` | `1` | Max concurrent active sessions |

---

## Session Storage (Chat)

Chat session metadata lives in SQLite via `SessionIndexService` (`sessions.sqlite`), while messages and semantic search stay in LanceDB (`ollama-copilot.lance`).

- **Storage scope**: Data is stored per-workspace using `ExtensionContext.storageUri` with a fallback to `globalStorageUri` when no workspace is open.

- **Session index**: `SessionIndexService` (sql.js, offset pagination, sorted by `updated_at DESC`).
- **Messages**: LanceDB `messages` table only (no `sessions` table). Legacy LanceDB sessions are migrated to SQLite on startup.
- **Deletion**: `deleteSession()` removes from SQLite and deletes messages in LanceDB.

## Pagination

Session list uses offset-based pagination:

- Backend returns `{ hasMore, nextOffset }`.
- Webview requests `loadMoreSessions` with `{ offset }`.

---

## Database Architecture & Critical Rules

### Dual-Database Design

This extension uses **two separate databases**:

| Database | Technology | Purpose | Location |
|----------|------------|---------|----------|
| Sessions | SQLite (sql.js) | Session metadata (id, title, mode, model, timestamps) | `sessions.sqlite` |
| Messages | LanceDB | Message content + vector embeddings for semantic search | `ollama-copilot.lance/` |

**Critical**: Sessions and messages are stored separately. Any operation that clears one MUST clear the other to maintain consistency.

### ⚠️ NEVER Auto-Delete User Data

**DO NOT** implement automatic deletion or recreation of the messages table. This includes:

- ❌ Auto-recreating tables on schema mismatch errors
- ❌ Auto-dropping tables on corruption detection
- ❌ Silent data deletion to "recover" from errors

**Why**: Automatic deletion destroys user chat history without consent. Users lose valuable conversation context and have no way to recover it.

**Instead**: Provide manual controls in Advanced Settings for destructive operations, with clear warnings via VS Code's native modal dialogs.

### Schema Mismatch Handling

LanceDB can throw errors like `Found field not in schema: <field_name>` when the table schema changes between versions.

**Correct approach**:
1. Log the error for debugging
2. Do NOT automatically recreate the table
3. Let the user manually trigger "Recreate Messages Table" from Advanced Settings if they choose to lose their data

### LanceDB Corruption Patterns

LanceDB stores data in `.lance` directories with metadata files referencing data files. Corruption can occur when:
- Data files are deleted but metadata still references them
- Extension crashes mid-write
- Filesystem issues

**Error signature**: `Not found: .../ollama-copilot.lance/messages.lance/data/<uuid>.lance`

**Handling**: The `handleCorruptedMessagesTable()` function detects missing file errors and can recreate the table, but this is only called during initialization, not automatically on every query.

### Message Ordering

Messages must have strictly increasing timestamps to ensure correct display order. The `getNextTimestamp(sessionId)` function guarantees this by:
1. On first call for a session (or when switching sessions), querying the database for the max timestamp in that session
2. Caching the `lastTimestamp` and `lastTimestampSessionId` to avoid repeated DB queries
3. Returning `max(Date.now(), lastTimestamp + 1)` for each subsequent message

**Critical**: The timestamp must be fetched from the database on extension restart or session switch, because the in-memory `lastTimestamp` resets to 0. Without this, new messages could get timestamps lower than existing messages, causing them to appear out of order.

### Agent Message Persistence Order

During agent execution, messages must be saved to the database in the exact order they appear in real-time:
1. **User message** - saved immediately when received
2. **Assistant explanation** - saved BEFORE tool execution (if the LLM provides explanation text before calling tools)
3. **Tool messages** - saved as each tool completes
4. **Final summary** - saved after all tools complete

**Why this matters**: If assistant explanations are only saved at the end (after tools), they get timestamps later than the tools, causing incorrect display order when loading from history.

### Single Assistant Message (Critical UI Contract)

For each **single user prompt**, the UI must show **exactly one assistant message**. The assistant message must **contain**:
1. The initial explanation text
2. The tool UI blocks (progress groups + command approvals) **embedded inside the same message**
3. The final summary appended **after** the tool blocks

**Absolutely required behavior**:
- ✅ The assistant message is created once and **updated in place** as streaming continues.
- ✅ Tool UI blocks render **inside** the assistant message, not as separate timeline items.
- ✅ After tools finish, the final summary is appended to the **same** assistant message.

**Absolutely forbidden behavior**:
- ❌ Do NOT create a second assistant message for the final summary.
- ❌ Do NOT render tool blocks as standalone timeline items outside the assistant message.
- ❌ Do NOT overwrite or erase the initial explanation when tools finish.

**History loading must match real-time**: When loading from the database, the timeline must be rebuilt to produce the same structure as live streaming.

### Assistant Thread UI Structure (Webview)

The webview represents each assistant response as a **single assistant thread item** with a `blocks` array:

```typescript
interface AssistantThreadItem {
  id: string;
  type: 'assistantThread';
  role: 'assistant';
  blocks: Array<TextBlock | ToolsBlock>;
  model?: string;
}

interface TextBlock {
  type: 'text';
  content: string;
}

interface ToolsBlock {
  type: 'tools';
  tools: Array<ProgressItem | CommandApprovalItem>;
}
```

**Block ordering**: Blocks are added sequentially as events occur:
1. Thread starts with empty text block: `[{ type: 'text', content: '' }]`
2. When tools start: `[text, { type: 'tools', tools: [...] }]`
3. After tools, more text: `[text, tools, { type: 'text', content: '...' }]`
4. More tools: `[text, tools, text, tools]`
5. Final summary: `[text, tools, text, tools, text]`

**Rules**:
- The assistant thread is the only container for tool UI blocks during an assistant response.
- Never render tool blocks as standalone timeline items outside the assistant thread.
- Both live handlers and `timelineBuilder` create an initial empty text block for consistency.

### Streaming Behavior

The backend sends **accumulated content** with each stream chunk, not incremental deltas:

```typescript
// Backend sends: "Hello", then "Hello World", then "Hello World!"
// NOT: "Hello", then " World", then "!"
handleStreamChunk({ content: 'Hello World!' }); // replaces, not appends
```

The `handleStreamChunk` handler **replaces** the text block content, it does not append.

### UI Event Persistence

UI events (progress groups, tool actions, approvals) are persisted as `__ui__` tool messages:

```typescript
{
  role: 'tool',
  toolName: '__ui__',
  toolOutput: JSON.stringify({
    eventType: 'startProgressGroup' | 'showToolAction' | 'finishProgressGroup' | 'requestToolApproval' | 'toolApprovalResult' | 'requestFileEditApproval' | 'fileEditApprovalResult',
    payload: { ... }
  })
}
```

**Persisted events** (saved to database):
- `startProgressGroup` - Creates new progress group
- `showToolAction` - Adds action to progress group (only final states, not transient "running" states)
- `finishProgressGroup` - Marks group as done/collapsed
- `requestToolApproval` - Creates pending terminal command approval card + "Awaiting approval" action
- `toolApprovalResult` - Updates terminal command approval status and action status
- `requestFileEditApproval` - Creates pending file edit approval card with diff + "Awaiting approval" action
- `fileEditApprovalResult` - Updates file edit approval status and action status

**Not persisted** (transient UI states):
- "Running" status updates that will be replaced by final status
- Intermediate streaming content (only final content is saved as assistant message)

### Editable Command Approvals

Users can edit terminal commands before approval. The edited command must be sent to the backend and executed exactly as edited.

**Required behavior**:
- The command input is editable **only while status is `pending`**.
- Approving sends `{ approvalId, approved: true, command }` to the backend.
- Backend must execute the edited command and echo the final command back in `toolApprovalResult` so the UI reflects what was run.

**Forbidden**:
- ❌ Do NOT ignore user edits and run the original command.
- ❌ Do NOT allow editing after approval.

### Clearing All Data

When implementing "clear all data" functionality:
1. Drop/recreate LanceDB messages table via `DatabaseService.recreateMessagesTable()`
2. Clear SQLite sessions via `SessionIndexService.clearAllSessions()`
3. **Refresh the sessions list in the UI** by sending `loadSessions` with an empty array:
   ```typescript
   this.emitter.postMessage({
     type: 'loadSessions',
     sessions: [],
     hasMore: false,
     nextOffset: null
   });
   ```

All three steps are required - clearing databases without refreshing the UI leaves stale sessions visible.

### Webview Dialog Restrictions

Webviews run in a sandboxed iframe without `allow-modals`. This means:
- ❌ `confirm()` throws: "The document is sandboxed, and the 'allow-modals' keyword is not set"
- ❌ `alert()` and `prompt()` also fail

**Solution**: For confirmation dialogs, send a message to the extension backend and use VS Code's native `vscode.window.showWarningMessage()` with `{ modal: true }`:

```typescript
const result = await vscode.window.showWarningMessage(
  'This will delete all chat history. Continue?',
  { modal: true },
  'Delete'
);
if (result === 'Delete') {
  // proceed with deletion
}
```

---

## Agent Execution Flow

When user sends a message in Agent mode:

```
1. handleAgentMode()
   ├─ Create agent session
   ├─ Create git branch (if enabled)
   └─ executeAgent()
       └─ Loop (max iterations):
           ├─ Send messages to LLM
           ├─ Stream response
           ├─ Parse for <tool_call> blocks
           ├─ If tool calls found:
           │   ├─ Send 'startProgressGroup' to UI
           │   ├─ For each tool:
           │   │   ├─ Send 'showToolAction' (running)
           │   │   ├─ Execute tool via ToolRegistry
           │   │   ├─ Send 'showToolAction' (success/error)
           │   │   └─ Add result to messages
           │   └─ Continue loop
           ├─ If [TASK_COMPLETE]:
           │   └─ Break loop
           └─ Send 'finalMessage' to UI
```

---

## UI Component Communication

### Backend → Frontend Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `init` | `{models, settings, hasToken}` | Initialize UI with settings |
| `settingsUpdate` | `{settings, hasToken}` | Push updated settings to webview |
| `showThinking` | `{message, sessionId}` | Show loading state for a session |
| `hideThinking` | `{sessionId}` | Hide loading state for a session |
| `startProgressGroup` | `{title, sessionId}` | Start collapsible group |
| `showToolAction` | `{status, icon, text, detail, sessionId}` | Add action to group |
| `finishProgressGroup` | `{sessionId}` | Mark group complete |
| `streamChunk` | `{content, model?, sessionId}` | Stream assistant response scoped to a session |
| `finalMessage` | `{content, model?, sessionId}` | Finalize response scoped to a session |
| `generationStarted` | `{sessionId}` | Mark session as generating |
| `generationStopped` | `{sessionId}` | Mark session as stopped |
| `addMessage` | `{message, sessionId}` | Append a message in a specific session |
| `loadSessionMessages` | `{messages, sessionId}` | Load messages for a session |
| `loadSessions` | `{sessions, hasMore, nextOffset}` | Update sessions list |
| `appendSessions` | `{sessions, hasMore, nextOffset}` | Append sessions list |
| `dbMaintenanceResult` | `{success, deletedSessions?, deletedMessages?, message?}` | Maintenance result |
| `connectionTestResult` | `{success, message}` | Connection test result |
| `bearerTokenSaved` | `{hasToken}` | Token save confirmation |

### Frontend → Backend Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `ready` | - | UI initialized (triggers `init` response) |
| `sendMessage` | `{text, context}` | User message |
| `stopGeneration` | `{sessionId}` | Cancel generation for a session |
| `selectMode` | `{mode}` | Change mode |
| `selectModel` | `{model}` | Change model |
| `newChat` | - | Create new session |
| `loadSession` | `{sessionId}` | Load session |
| `deleteSession` | `{sessionId}` | Delete session |
| `saveSettings` | `{settings}` | Save settings |
| `testConnection` | - | Test server connection |
| `saveBearerToken` | `{token, testAfterSave?}` | Save bearer token (optionally test after) |
| `loadMoreSessions` | `{offset}` | Load more sessions |
| `runDbMaintenance` | - | Run DB maintenance cleanup |

### Session-Concurrent Streaming

- Streaming, tool actions, and progress updates are routed with `sessionId`.
- The webview ignores updates that do not match the currently active session.
- Background sessions continue generating; switching sessions does not stop generation.
- The Stop button sends `stopGeneration` with the active `sessionId`.

---

## Chat View Backend Structure (Expected)

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

---

## CSS Theming

The chat UI uses VS Code's CSS variables for theming:

```css
--vscode-editor-background
--vscode-editor-foreground
--vscode-input-background
--vscode-input-foreground
--vscode-input-border
--vscode-focusBorder
--vscode-button-background
--vscode-button-foreground
--vscode-list-hoverBackground
--vscode-scrollbarSlider-background
```

---

## UI Conventions (Chat)

- Assistant responses expose the model name in the payload (`model`) and render it as a bottom-right hover label in the message container.
- Assistant responses show a dashed divider after each assistant message, except for the very last timeline item. Divider style:
  - `border-top: 1px dashed var(--vscode-chat-checkpointSeparator);`
  - `margin: 15px 0;`

### Responsive Sessions Panel (Webview)

- The sessions panel is responsive and auto-opens/closes based on webview width.
- The sessions panel width is `17.5rem` in `webview/styles/components/_sessions.scss`.
- The auto-close threshold is rem-based (currently `34rem`) and is enforced in `webview/App.vue` using a `ResizeObserver`.
- Manual toggles trigger sidebar resize via a `resizeSidebar` message from webview to the extension.
- Extension handles `resizeSidebar` in `src/views/chatView.ts` by executing:
  - `workbench.action.increaseSideBarWidth`
  - `workbench.action.decreaseSideBarWidth`

---

## Development Guidelines

### Critical Meta (Non-Negotiable)

- Keep this file (`.github/copilot-instructions.md`) up to date whenever behavior, message payloads, settings, storage, or UI contracts change.
- Build or update automated tests whenever features are added/updated.
  - Use Vitest for webview core logic/components (`webview/tests`).
  - Use `@vscode/test-electron` for VS Code/extension integration (`src/test`).
- Do not land changes unless the project is green:
  - Run `npm run test:all` locally when practical.
  - CI must pass (webview tests + extension-host tests).

### Maintain Clean Structure (Important)

Keep the current folder layout clean and consistent. Do not reintroduce flat, mixed files. Follow these rules:

- Webview source stays directly under `webview/` (no extra `chatView/` folder).
- UI markup goes in `webview/components/*.vue`.
- App wiring and message handling live in `webview/scripts/app/App.ts`.
- Shared logic lives in `webview/scripts/core/`:
  - State/refs: `state.ts`
  - Computed values: `computed.ts`
  - Actions/helpers: `actions/` (split modules + `actions/index.ts` barrel)
  - Message handlers: `messageHandlers/` (split modules + `messageHandlers/index.ts` router)
  - Timeline rebuild: `timelineBuilder.ts`
  - Types: `types.ts`
- Styles use SCSS with an entry file at `webview/styles/styles.scss` and partials grouped under `webview/styles/` (base/layout/components/utils).

**Do not reintroduce monoliths**:
- ❌ Avoid resurrecting `webview/scripts/core/actions.ts` or `messageHandlers.ts` as large single files.
- ✅ Add new actions in `webview/scripts/core/actions/*` and export from `actions/index.ts`.
- ✅ Add new message handlers in `webview/scripts/core/messageHandlers/*` and register in `messageHandlers/index.ts`.
- ✅ `App.ts` should only route messages and export barrels.

If you add new functionality, place it in the appropriate folder above and keep files small and single-purpose. Avoid creating new “catch-all” files.

### Build Validation (Required)

- After making code changes, ensure the project still compiles successfully.
- Use `npm run compile` to verify the extension and webview build.

### Automated Testing (Required)

This repo uses two complementary test harnesses:

1) **Extension host tests (integration-ish)**
- Runner: `@vscode/test-electron` + Mocha
- Command: `npm test`
- Location:
  - Test harness + mocks: `src/test/`
  - Test suites: `src/test/suite/`
    - `src/test/suite/utils/` for pure utilities
    - `src/test/suite/services/` for service-level integration tests

2) **Webview tests (fast unit/component)**
- Runner: Vitest + jsdom + Vue Test Utils
- Command: `npm run test:webview`
- Location: `webview/tests/`
- Config: `webview/vitest.config.ts`

To run everything locally (recommended before pushing): `npm run test:all`.

#### What to test with Vitest vs `@vscode/test-electron`

Use the two harnesses for different risk profiles:

**Prefer Vitest (webview/tests) when:**
- You’re testing UI “business logic” that should be fast, deterministic, and not depend on VS Code.
- The target lives in `webview/scripts/core/*` (state/actions/computed) or a Vue component with clear props/events.
- You want tight coverage on edge cases that are painful to validate via a full VS Code host.

Good Vitest targets:
- `webview/scripts/core/actions.ts`: debounced search, context packaging for send, tool/approval UI updates, message/thread merging behavior.
- `webview/scripts/core/computed.ts`: header/title selection, derived counts, tool timeout conversions.
- Vue components with important contracts:
  - `webview/components/CommandApproval.vue`: editable command only when `status === 'pending'`; approve sends edited command.
  - `webview/components/SessionsPanel.vue`: pagination (`loadMoreSessions`) + selection (`loadSession`) + loading flags.

**Prefer `@vscode/test-electron` (src/test) when:**
- You need real VS Code APIs (`vscode`), extension activation, commands, view registration, or storage URIs.
- You’re validating backend/service behavior (SQLite sessions, LanceDB messages, ordering/maintenance, tool execution).
- You want to cover multi-module integration flows end-to-end (even if the UI is mocked).

Good `@vscode/test-electron` targets:
- Extension activation and message routing (`ChatViewProvider` → controllers/services).
- `DatabaseService` invariants (timestamps strictly increasing; maintenance never deletes sessions; delete cascades).
- Mocked Ollama/OpenWebUI HTTP interactions (streaming NDJSON, retry, connection test) using the local mock server.

**Rule of thumb:**
- If the bug would show up as “wrong state / wrong UI rendering / wrong postMessage payload”, write Vitest.
- If the bug would show up as “VS Code integration broken / storage broken / commands missing / streaming broken”, write `@vscode/test-electron`.

**High-ROI next webview tests to add (Vitest):**
- Sessions UI: `SessionsPanel.vue` pagination and selection behavior (load more, click session, correct postMessage payloads).

#### Existing test coverage (Vitest)

The following test suites exist in `webview/tests/`:

**`timelineBuilder.test.ts`** (23 tests) - Tests the `buildTimelineFromMessages` function:
- Block-based structure: user messages, assistant threads, text block merging
- UI event replay: `startProgressGroup`, `showToolAction`, `finishProgressGroup`
- Command approval flow: `requestToolApproval`, `toolApprovalResult`, skipped status
- **File edit approval flow**: `requestFileEditApproval`, `fileEditApprovalResult`
- Full workflow matching live/history parity
- Edge cases: implicit groups, orphan approvals, invalid JSON handling
- **Critical**: finishProgressGroup converts pending/running actions to success

**`messageHandlers.test.ts`** (11 tests) - Tests live message handlers:
- Streaming handlers: `handleStreamChunk` creates/updates text blocks
- Progress group handlers: start/show/finish progress groups
- Approval handlers with live/history parity: both progress group action AND approval card
- **Critical contract test**: `complete workflow produces same structure as timelineBuilder`
- **Critical contract test**: `file edit approval workflow produces same structure as timelineBuilder`

**`actions.test.ts`** (7 tests) - Tests UI actions:
- Debounced search behavior
- Auto-approve toggle/confirm
- Context packaging for send

**`computed.test.ts`** (4 tests) - Tests derived state:
- Temperature display formatting

**`CommandApproval.test.ts`** (2 tests) - Tests Vue component:
- Editable command input only when status is `pending`

#### Existing test coverage (Extension Host)

The following test suites exist in `src/test/suite/`:

**`utils/toolCallParser.test.ts`** (24 tests) - Tests tool call parsing robustness:
- Basic parsing: XML and bracket format tool calls
- Balanced JSON extraction: nested objects, deeply nested content
- Alternative argument names: `arguments`, `args`, `params`, `parameters`
- Top-level arguments: when LLM puts args at root level
- Alternative tool name fields: `name`, `tool`, `function`
- Incomplete tool calls: LLM cutoff handling, missing closing braces
- Edge cases: escaped quotes, newlines, surrounding text, empty args
- Smart quote normalization: Unicode U+201C and U+201D to regular quotes

**`agent/toolRegistry.test.ts`** (17 tests) - Tests tool execution:
- read_file: accepts `path`, `file`, `filePath` arguments
- write_file: accepts multiple path formats, writes JSON and special characters
- list_files: lists workspace root correctly
- get_diagnostics: accepts multiple path argument names
- Tool registration: verifies all expected tools are registered

**`services/databaseService.test.ts`** - Tests database operations:
- Message timestamps are strictly increasing
- Maintenance never deletes sessions

**`utils/commandSafety.test.ts`** - Tests terminal command safety analysis:
- Dangerous command detection (rm -rf, sudo, etc.)
- Platform-specific filtering

#### Webview test rules (important)

- The webview runtime provides `acquireVsCodeApi()`. Our webview state module calls it **at import-time** in `webview/scripts/core/state.ts`.
- Therefore, tests MUST stub `acquireVsCodeApi` before importing any webview core modules.
  - This is handled centrally in `webview/tests/setup.ts` via Vitest `setupFiles`.
- Prefer testing logic in `webview/scripts/core/*` (state/actions/computed) over directly testing `webview/scripts/app/App.ts`.
  - `App.ts` wires `window.addEventListener('message', ...)` and is intentionally more integration-heavy.
- When asserting message sends to the extension, assert calls to the stubbed `postMessage` function.
- Keep tests deterministic: use `vi.useFakeTimers()` for debounced functions (e.g. search) and `vi.setSystemTime()` when IDs/timestamps are time-based.

### Adding a New Tool

1. Add to `toolRegistry.ts` in `registerBuiltInTools()`:
```typescript
this.register({
  name: 'my_tool',
  description: 'What this tool does',
  schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Param description' }
    },
    required: ['param1']
  },
  execute: async (params, context) => {
    // Implementation
    return 'Result string';
  }
});
```

2. Add UI representation in `getToolActionInfo()` in chatView.ts

3. Add to Tools section in settings UI (HTML in chatView.ts)

### Adding a New Mode

1. Create file in `src/modes/myMode.ts`
2. Export `registerMyMode(context, client, ...)` function
3. Call from `extension.ts` activate function
4. Add to mode selector in chatView.ts HTML

### Modifying the Chat UI

The chat UI is a Vue app under `webview/`:
- `App.vue` composes UI subcomponents and contains the `onMounted` hook that sends the `ready` message
- `components/*.vue` holds UI sections (chat page, settings, header, sessions)
- `scripts/app/App.ts` wires message handling and exports state/actions
- `scripts/core/*` holds state, computed values, actions, and types
- `styles/styles.scss` is the SCSS entry; partials live under `styles/`
- `main.ts` bootstraps the Vue app

### Meta: Keep Instructions Updated

When you introduce new UI behavior, message payload fields, or architectural changes, update this file to reflect the new conventions and payload shapes.

**Important**: Vue lifecycle hooks like `onMounted` must be called inside a Vue component's `<script setup>` block. Do NOT place them in plain `.ts` files - they won't execute!

Build output goes to `media/` and is loaded by `ChatViewProvider`.

---

## Build & Run

```bash
# Install dependencies
npm install

# Build webview + extension
npm run build:all

# Compile (production)
npm run compile

# Webview only
npm run build:webview

# Watch mode (development)
npm run watch

# Package extension
vsce package
```

---

## Testing the Extension

1. Press F5 in VS Code to launch Extension Development Host
2. Open the Ollama Copilot sidebar (Activity Bar icon)
3. Ensure Ollama is running at configured URL
4. Test each mode:
   - **Agent**: "Create a hello world TypeScript file"
   - **Ask**: "Explain this code"
   - **Edit**: Select code, use Edit command

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "Cannot connect to Ollama" | Ensure Ollama is running: `ollama serve` |
| No models in dropdown | Run `ollama pull <model>` first |
| Agent not using tools | Model may not support function calling - use larger model |
| Settings not saving | Check VS Code settings sync |
| UI not updating | Reload window or restart extension host |

---

## Key Files for Common Tasks

| Task | File(s) |
|------|---------|
| Modify chat UI | `src/views/chatView.ts` |
| Add agent tools | `src/agent/toolRegistry.ts` |
| Change API behavior | `src/services/ollamaClient.ts` |
| Modify settings | `package.json` + `src/config/settings.ts` |
| Change inline completions | `src/providers/completionProvider.ts` |
| Modify agent prompts | `buildAgentSystemPrompt()` in chatView.ts |
| Message storage (LanceDB) | `src/services/databaseService.ts` |
| Session storage (SQLite) | `src/services/sessionIndexService.ts` |
| DB maintenance actions | `src/views/settingsHandler.ts` |
