# Ollama Copilot - Project Instructions

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
│   │       ├── actions.ts  # UI actions + helpers
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

**History loading must match real-time**: When loading from the database, assistant explanations before tools and summaries after tools must be merged into the **same assistant message** with tool blocks embedded between them.

### Assistant Thread UI Structure (Webview)

The webview represents each assistant response as a **single assistant thread item** with three parts:
1. `contentBefore` (assistant explanation)
2. `tools` (progress groups + command approvals embedded inside the same message)
3. `contentAfter` (final summary)

**Rules**:
- The assistant thread is the only container for tool UI blocks during an assistant response.
- Never render tool blocks as standalone timeline items outside the assistant thread.
- During streaming, update `contentBefore` until tools start; after tools start, update `contentAfter`.

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

### Maintain Clean Structure (Important)

Keep the current folder layout clean and consistent. Do not reintroduce flat, mixed files. Follow these rules:

- Webview source stays directly under `webview/` (no extra `chatView/` folder).
- UI markup goes in `webview/components/*.vue`.
- App wiring and message handling live in `webview/scripts/app/App.ts`.
- Shared logic lives in `webview/scripts/core/`:
  - State/refs: `state.ts`
  - Computed values: `computed.ts`
  - Actions/helpers: `actions.ts`
  - Types: `types.ts`
- Styles use SCSS with an entry file at `webview/styles/styles.scss` and partials grouped under `webview/styles/` (base/layout/components/utils).

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
- Message-handling invariants: one user prompt must map to exactly one assistant thread item with tool blocks embedded between `contentBefore` and `contentAfter` (test via `webview/scripts/core/actions.ts` helpers and/or the message-assembly logic).
- Sessions UI: `SessionsPanel.vue` pagination and selection behavior (load more, click session, correct postMessage payloads).

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
