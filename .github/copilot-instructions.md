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
│   ├── askMode.ts        # Q&A mode (deprecated, now in chatView)
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
│   └── tokenManager.ts   # Bearer token management
├── views/
│   └── chatView.ts       # Main chat sidebar (2400+ lines)
├── webview/
│   └── setupWizard.ts    # First-run setup wizard
├── templates/            # Prompt templates
├── types/                # TypeScript type definitions
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

**Features:**
- **Multiple Modes**: Agent, Ask, Edit (selectable via dropdown)
- **Sessions Management**: Create, switch, delete chat sessions
- **Settings Page**: Continue.dev-style settings with navigation sidebar
- **Progress Groups**: Copilot-style collapsible action groups

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
| `init` | `{models, settings, hasToken}` | Initialize UI |
| `showThinking` | `{message}` | Show loading state |
| `hideThinking` | - | Hide loading state |
| `startProgressGroup` | `{title}` | Start collapsible group |
| `showToolAction` | `{status, icon, text, detail}` | Add action to group |
| `finishProgressGroup` | - | Mark group complete |
| `streamChunk` | `{content}` | Stream assistant response |
| `finalMessage` | `{content}` | Finalize response |
| `loadSessions` | `{sessions}` | Update sessions list |
| `connectionTestResult` | `{success, message}` | Connection test result |

### Frontend → Backend Messages

| Message Type | Payload | Purpose |
|--------------|---------|---------|
| `ready` | - | UI initialized |
| `sendMessage` | `{text, context}` | User message |
| `stopGeneration` | - | Cancel current generation |
| `selectMode` | `{mode}` | Change mode |
| `selectModel` | `{model}` | Change model |
| `newChat` | - | Create new session |
| `loadSession` | `{sessionId}` | Load session |
| `deleteSession` | `{sessionId}` | Delete session |
| `saveSettings` | `{settings}` | Save settings |
| `testConnection` | - | Test server connection |
| `saveBearerToken` | `{token}` | Save bearer token |

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

## Development Guidelines

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

The entire chat UI is in `src/views/chatView.ts`:
- HTML template: `getHtmlForWebview()` method (starts around line 700)
- CSS: Inside `<style>` tag in the template
- JavaScript: Inside `<script>` tag at end of template
- Backend handlers: `onDidReceiveMessage` switch statement

---

## Build & Run

```bash
# Install dependencies
npm install

# Compile (production)
npm run compile

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
