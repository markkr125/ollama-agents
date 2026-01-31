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
│   ├── modelCompatibility.ts # Model feature detection
│   ├── modelManager.ts   # Model listing/selection
│   ├── ollamaClient.ts   # Ollama API client
│   ├── sessionIndexService.ts # SQLite-backed chat session index
│   └── tokenManager.ts   # Bearer token management
├── views/
│   └── chatView.ts       # Main chat sidebar (2400+ lines)
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

The main sidebar chat interface - a WebviewViewProvider that renders a GitHub Copilot-style UI.
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
3. Based on mode, calls `handleAgentMode`, `handleChatMode`, etc.
4. Streams response back via `postMessage`
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

---

## Session Storage (Chat)

Chat session metadata lives in SQLite via `SessionIndexService` (`sessions.sqlite`), while messages and semantic search stay in LanceDB (`ollama-copilot.lance`).

- **Session index**: `SessionIndexService` (sql.js, offset pagination, sorted by `updated_at DESC`).
- **Messages**: LanceDB `messages` table only (no `sessions` table). Legacy LanceDB sessions are migrated to SQLite on startup.
- **Deletion**: `deleteSession()` removes from SQLite and deletes messages in LanceDB.

## Pagination

Session list uses offset-based pagination:

- Backend returns `{ hasMore, nextOffset }`.
- Webview requests `loadMoreSessions` with `{ offset }`.

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
| `showThinking` | `{message}` | Show loading state |
| `hideThinking` | - | Hide loading state |
| `startProgressGroup` | `{title}` | Start collapsible group |
| `showToolAction` | `{status, icon, text, detail}` | Add action to group |
| `finishProgressGroup` | - | Mark group complete |
| `streamChunk` | `{content, model?}` | Stream assistant response (optional model name) |
| `finalMessage` | `{content, model?}` | Finalize response (optional model name) |
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
| `stopGeneration` | - | Cancel current generation |
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
