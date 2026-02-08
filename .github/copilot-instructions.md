# Ollama Copilot - Project Instructions

> **Scoped instructions & skills**: This file contains project-wide rules only. File-specific details live in scoped instruction files that are automatically loaded when editing matching files. See the full list below.
>
> | File | Scope (`applyTo`) | Content |
> |------|-------------------|---------|
> | `.github/instructions/database-rules.instructions.md` | `src/services/databaseService.ts,src/services/sessionIndexService.ts,src/views/settingsHandler.ts` | Dual-DB design, schema mismatch, LanceDB corruption, message ordering, clearing data |
> | `.github/instructions/ui-messages.instructions.md` | `src/views/**,src/webview/**` | Backend↔frontend message protocol (full type tables), chat view structure, streaming behavior |
> | `.github/instructions/webview-ui.instructions.md` | `src/webview/**` | Assistant thread structure, CSS theming, diff2html, Vue patterns, session UX |
> | `.github/instructions/testing.instructions.md` | `tests/**` | Test harnesses, coverage catalogs, webview test rules |
> | `.github/instructions/agent-tools.instructions.md` | `src/agent/**,src/services/agentChatExecutor.ts,src/utils/toolCallParser.ts` | Agent execution flow, tool registry, tool call parser, terminal execution, command safety, approval flow |
> | `.github/instructions/extension-architecture.instructions.md` | `src/extension.ts,src/config/**,src/services/**,src/types/**` | Type system (3 message interfaces), service init order, config patterns, OllamaClient API, terminal manager, model compatibility |
> | `.github/instructions/documentation.instructions.md` | `docs/**,README.md` | Doc index maintenance, cross-link rules, TOC requirement, content rules, when to update |
>
> **Skills** (loaded on-demand by Copilot when relevant):
> | Skill | Description |
> |-------|-------------|
> | `.github/skills/copilot-custom-instructions/` | How to write `.instructions.md` and `SKILL.md` files |
> | `.github/skills/add-agent-tool/` | Step-by-step guide for adding a new agent tool |
> | `.github/skills/add-new-setting/` | Step-by-step guide for adding a new VS Code configuration setting |
> | `.github/skills/add-chat-message-type/` | Step-by-step guide for adding a new backend↔frontend message type |
> | `.github/skills/add-test/` | Step-by-step guide for adding a new test (choose harness, file placement, imports, conventions) |

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
| `thinkingBlock` | After model finishes a thinking round | `{ content }` |
| `showError` | On fatal loop error before break | `{ message }` |

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

## ⚠️ CRITICAL RULE #2: NEVER Auto-Delete User Data

**DO NOT** implement automatic deletion or recreation of the messages table. This includes:

- ❌ Auto-recreating tables on schema mismatch errors
- ❌ Auto-dropping tables on corruption detection
- ❌ Silent data deletion to "recover" from errors

**Instead**: Provide manual controls in Advanced Settings with clear warnings via VS Code's native modal dialogs.

---

## ⚠️ CRITICAL RULE #3: Single Assistant Message

For each **single user prompt**, the UI must show **exactly one assistant message** containing:
1. The initial explanation text
2. The tool UI blocks (progress groups + command approvals) **embedded inside the same message**
3. The final summary appended **after** the tool blocks

**Required**:
- ✅ The assistant message is created once and **updated in place** as streaming continues.
- ✅ Tool UI blocks render **inside** the assistant message, not as separate timeline items.
- ✅ After tools finish, the final summary is appended to the **same** assistant message.

**Forbidden**:
- ❌ Do NOT create a second assistant message for the final summary.
- ❌ Do NOT render tool blocks as standalone timeline items outside the assistant message.
- ❌ Do NOT overwrite or erase the initial explanation when tools finish.

**History loading must match real-time**: When loading from the database, the timeline must be rebuilt to produce the same structure as live streaming.

---

## ⚠️ Common Pitfalls (Quick Reference)

These are the mistakes most frequently made when editing this codebase. **Check this list before submitting any change.**

| # | Pitfall | Why It Breaks | Correct Approach |
|---|---------|---------------|------------------|
| 1 | Importing `vscode` in webview code (`src/webview/**`) | Webview runs in a sandboxed iframe — `vscode` module does not exist there. Build will succeed but runtime crashes. | Use `acquireVsCodeApi()` (already called in `state.ts`). Communicate with the extension via `postMessage`. |
| 2 | Editing files in `media/`, `dist/`, or `out/` | These are **build outputs**, not source. Changes are overwritten on next build. | Edit source in `src/` and `src/webview/`. See **Build Output Directories** in `extension-architecture.instructions.md`. |
| 3 | Treating `streamChunk` content as a delta | `streamChunk` sends **accumulated** content ("Hello World"), not incremental (" World"). The handler **replaces** the text block, not appends. | Always replace the entire text block content with the received `content` string. |
| 4 | Using `isPathSafe()` result without inverting | `isPathSafe()` returns `true` = path IS safe (no approval needed), `false` = requires approval. The name is intuitive but the usage often gets flipped. | `if (!isPathSafe(path)) { /* require approval */ }` — see `⚠️ INVERTED BOOLEAN` in `agent-tools.instructions.md`. |
| 5 | Adding logic directly to `chatView.ts` | `chatView.ts` is intentionally thin — only lifecycle + routing. | Delegate to `chatSessionController.ts` (sessions), `settingsHandler.ts` (settings), or `agentChatExecutor.ts` (agent). |
| 6 | `sensitiveFilePatterns` value `true` means "is sensitive" | **Wrong.** `true` = auto-approve (NOT sensitive). `false` = require approval (IS sensitive). The boolean is inverted from what the key name suggests. | `{ "**/.env*": false }` → `.env` files require approval. |
| 7 | Posting a UI event without persisting it | Breaks session history — live chat shows the event but reloaded sessions don't. Violates CRITICAL RULE #1. | Always call `persistUiEvent()` alongside every `postMessage()`, in the same order. |
| 8 | Placing Vue lifecycle hooks in plain `.ts` files | `onMounted`, `onUnmounted`, etc. silently do nothing outside a Vue component's `<script setup>` block. | Keep lifecycle hooks inside `.vue` files only. |
| 9 | Importing webview core modules in tests without stubbing `acquireVsCodeApi` | `state.ts` calls `acquireVsCodeApi()` at **import time**. Any test importing state (or modules that import state) crashes immediately. | This is handled by `tests/webview/setup.ts` — ensure Vitest config includes it in `setupFiles`. |
| 10 | Using `out/` as extension runtime output | `out/` is only for **test compilation** (`tsc`). The extension runtime bundle is in `dist/` (webpack). | Never reference `out/` in `package.json` "main" or runtime code paths. |
| 11 | Restructuring `.github/instructions/`, `.github/skills/`, or `docs/` | The preamble table in this file, `docs/README.md` index, and `npm run lint:docs` all validate structure. Renaming, moving, or deleting these files breaks cross-references. | Run `npm run lint:docs` after any docs/instructions/skills change. Keep the preamble table, docs index, and frontmatter in sync. |
| 12 | Omitting `tool_name` or `thinking` from conversation history messages | The Ollama API requires `tool_name` on `role:'tool'` messages so the model knows which tool produced which result. Omitting `thinking` causes the model to lose chain-of-thought context across iterations. | Always include `tool_name` on tool result messages and `thinking` on assistant messages when thinking content exists. See `agent-tools.instructions.md` → Native Tool Calling. |

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
│   ├── agentChatExecutor.ts # Agent chat execution loop + tool handling
│   ├── modelCompatibility.ts # Model feature detection
│   ├── modelManager.ts   # Model listing/selection
│   ├── ollamaClient.ts   # Ollama API client
│   ├── sessionIndexService.ts # SQLite-backed chat session index
│   ├── terminalManager.ts # Terminal lifecycle + command execution
│   └── tokenManager.ts   # Bearer token management
├── views/
│   ├── chatView.ts       # Webview provider (thin orchestration)
│   ├── chatSessionController.ts # Session state + messages + list/search
│   ├── settingsHandler.ts # Settings + token + connection handling
│   ├── toolUIFormatter.ts # Pure mapping for tool UI text/icons
│   └── chatTypes.ts       # Shared view types + WebviewMessageEmitter
├── webview/              # Vue frontend (built by Vite)
│   ├── App.vue            # Vue root SFC (composes child components)
│   ├── main.ts            # Webview bootstrap
│   ├── index.html         # Webview HTML entry
│   ├── vite.config.ts     # Vite build config for webview
│   ├── components/        # Vue UI components (page-per-folder pattern)
│   │   ├── HeaderBar.vue       # Top bar (back, new chat, settings, sessions)
│   │   ├── SessionsPanel.vue   # Full-page sessions list + search
│   │   ├── chat/               # Chat feature folder
│   │   │   ├── ChatPage.vue         # Main page component (entry point)
│   │   │   └── components/          # Chat sub-components
│   │   │       ├── ChatInput.vue
│   │   │       ├── CommandApproval.vue
│   │   │       ├── FileEditApproval.vue
│   │   │       ├── MarkdownBlock.vue
│   │   │       ├── ProgressGroup.vue
│   │   │       └── SessionControls.vue
│   │   └── settings/           # Settings feature folder
│   │       ├── SettingsPage.vue     # Main page component (entry point)
│   │       └── components/          # Settings sub-components
│   │           ├── AdvancedSection.vue
│   │           ├── AgentSection.vue
│   │           ├── AutocompleteSection.vue
│   │           ├── ChatSection.vue
│   │           ├── ConnectionSection.vue
│   │           ├── ModelCapabilitiesSection.vue
│   │           └── ToolsSection.vue
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
│   └── styles/            # SCSS entry + partials
├── templates/            # Prompt templates
├── types/                # TypeScript type definitions
│   └── session.ts         # Shared chat + agent session types
└── utils/                # Utility functions

tests/                    # All tests (separate from source)
├── extension/            # @vscode/test-electron + Mocha
│   ├── runTest.ts         # Entry point — launches VS Code + mock server
│   ├── mocks/             # HTTP mock server for Ollama API
│   └── suite/             # Test suites (agent/, services/, utils/)
└── webview/              # Vitest + jsdom + Vue Test Utils
    ├── vitest.config.ts   # Vitest config
    ├── setup.ts           # Global setup (stubs acquireVsCodeApi)
    ├── core/              # State/actions/computed/timeline tests
    └── components/        # Vue component tests
```

---

## Agent Mode Request Lifecycle

When a user sends a message in agent mode, this is the full data flow:

```
User types message in webview
  → vscode.postMessage({ type: 'sendMessage', text, context })
  → chatView.ts: handleMessage()
      ├─ Persist user message to DB (MessageRecord)
      ├─ Post 'addMessage' + 'generationStarted' to webview
      └─ handleAgentMode()
          ├─ Create agent session + git branch (if git available)
          └─ agentChatExecutor.execute()
              ├─ Detect: useNativeTools (model has 'tools' cap) / useThinking
              └─ LOOP (max iterations):
                  ├─ Build chatRequest {model, messages, tools?, think?}
                  ├─ Stream LLM response via OllamaClient.chat()
                  │   ├─ Accumulate thinking (chunk.message.thinking)
                  │   ├─ Accumulate tool_calls (chunk.message.tool_calls)
                  │   └─ Throttled 'streamChunk' to webview (first-chunk gate: ≥8 word chars)
                  ├─ Persist thinking block (thinkingBlock UI event)
                  ├─ Extract tool calls:
                  │   ├─ Native: nativeToolCalls from API
                  │   └─ XML fallback: extractToolCalls(response)
                  ├─ Push assistant message to history (with thinking + tool_calls)
                  ├─ If tools found:
                  │   ├─ Persist + post 'startProgressGroup'
                  │   ├─ For each tool:
                  │   │   ├─ [Terminal cmd] → commandSafety → approval flow
                  │   │   ├─ [File edit] → fileSensitivity → approval flow
                  │   │   ├─ [Other tool] → direct execution via ToolRegistry
                  │   │   ├─ Persist tool result to DB
                  │   │   ├─ Persist + post 'showToolAction' (success/error)
                  │   │   └─ Feed result: {role:'tool', content, tool_name} (native)
                  │   │               or accumulated user msg (XML fallback)
                  │   └─ Persist + post 'finishProgressGroup'
                  ├─ If [TASK_COMPLETE] → validate writes → break loop
                  └─ Continue to next iteration
              → Persist final assistant message to DB
              → Post 'finalMessage' to webview
              → Post 'generationStopped'
```

**Key invariant**: Every `postMessage` to the webview has a matching `persistUiEvent` to the database, in the same order. This ensures session history matches live chat exactly.

---

## Core Components

### Type System — Quick Reference

There are **three message interfaces**. Using the wrong one is a common mistake:

| Interface | File | Use For |
|-----------|------|---------|
| `MessageRecord` | `src/types/session.ts` | Database persistence (snake_case fields) |
| `ChatMessage` | `src/views/chatTypes.ts` | Webview postMessage (camelCase + UI metadata) |
| Ollama `ChatMessage` | `src/types/ollama.ts` | API wire format (`role`, `content`, `tool_calls?`, `tool_name?`, `thinking?`) |

See the **"Three Message Interfaces"** section in `extension-architecture.instructions.md` for field-level details and conversion rules.

### OllamaClient (`src/services/ollamaClient.ts`)

The HTTP client for communicating with Ollama/OpenWebUI APIs.

**Key Methods:**
- `chat(request)` - Streaming chat completion (returns async generator)
- `generate(request)` - Non-chat text generation
- `listModels()` - Get available models
- `showModel(name)` - Fetch model details + capabilities via `/api/show`
- `fetchModelsWithCapabilities()` - `listModels()` + parallel `showModel()` for all models
- `testConnection()` - Verify server connectivity

**Configuration:**
- Supports both Ollama (`http://localhost:11434`) and OpenWebUI
- Bearer token authentication for OpenWebUI
- Automatic retry with exponential backoff

### ChatViewProvider (`src/views/chatView.ts`)

The main sidebar chat interface provider. It is intentionally **thin** and only handles:
- Webview lifecycle + message routing
- Mode dispatch (`agent` vs `chat/edit`)
- Delegation to helper services

The UI is built with Vue via Vite and emitted to `media/index.html`, `media/chatView.js`, and `media/chatView.css`.

**Performance:**
- Chat mode streaming is throttled at 32ms (~30fps) to reduce IPC overhead
- `MarkdownBlock.vue` components prevent full timeline re-renders on each chunk
- Session list updates are debounced and only sent when needed

### Settings Configuration

Settings are defined in `package.json` under `contributes.configuration`:

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.baseUrl` | `http://localhost:11434` | Ollama server URL |
| `ollamaCopilot.completionMode.model` | `""` | Model for inline completions |
| `ollamaCopilot.agentMode.model` | `""` | Model for agent tasks |
| `ollamaCopilot.agent.maxIterations` | `25` | Max tool execution cycles |
| `ollamaCopilot.agent.toolTimeout` | `30000` | Tool timeout in ms |
| `ollamaCopilot.agent.maxActiveSessions` | `1` | Max concurrent active sessions |

### Model Management

Models are managed in the **Models** settings tab (`ModelCapabilitiesSection.vue`). Key behaviors:

- **SQLite cache**: The model list (name, size, capabilities, `enabled` flag) is persisted in the `models` table. Falls back to the cache when Ollama is unreachable.
- **Enable/disable**: Each model has an `enabled` flag. Disabled models are hidden from all model selection dropdowns. Bulk "Enable All" / "Disable All" buttons are provided.
- **Capability detection**: On startup (and on manual refresh), the extension calls `/api/show` for each model to detect capabilities (chat, vision, FIM, tools, embedding). Results are cached in SQLite.
- **Auto-save**: Model selection dropdowns save automatically on change — no explicit save button.
- **Stale model cleanup**: `upsertModels()` in `sessionIndexService.ts` does `DELETE FROM models` before re-inserting, so models removed from Ollama are automatically dropped from the cache.

---

## Development Guidelines

### Critical Meta (Non-Negotiable)

- Keep instructions up to date whenever behavior, message payloads, settings, storage, or UI contracts change. Update the **relevant scoped file** (`.github/instructions/*.instructions.md` or `.github/skills/*/SKILL.md`), not just this root file.
- Build or update automated tests whenever features are added/updated.
  - Use Vitest for webview core logic/components (`tests/webview`).
  - Use `@vscode/test-electron` for VS Code/extension integration (`tests/extension`).
- Do not land changes unless the project is green:
  - Run `npm run test:all` locally when practical.
  - CI must pass (webview tests + extension-host tests).

### Post-Change Verification (Required)

After **any** code change, run through this checklist:

1. **Compile check**: `npm run compile` — must exit 0 (builds both webview via Vite and extension via webpack)
2. **Type check tests**: `npx tsc -p tsconfig.test.json --noEmit` — ensures test files still compile against changed source
3. **Run relevant tests**:
   - Changed `src/webview/**` → `npm run test:webview`
   - Changed `src/**` (non-webview) → `npm test`
   - Changed both or unsure → `npm run test:all`
4. **Check for regressions**: If you modified a message type, verify both the live handler (in `messageHandlers/`) and `timelineBuilder.ts` still agree
5. **Verify no stale imports**: If you moved or renamed a file, search for old import paths across the codebase
6. **Docs structure check**: If you touched `docs/`, `.github/instructions/`, or `.github/skills/`, run `npm run lint:docs`

### Adding a New Mode

1. Create handler in `src/modes/myMode.ts`
2. Export a `registerMyMode(context, client, ...)` function that registers VS Code commands
3. Call `registerMyMode(...)` from `extension.ts` `activate()` function
4. Add mode dispatch in `chatView.ts` `handleMessage()` — handle the `selectMode` message for your new mode
5. The webview sends `{ type: 'selectMode', mode: 'myMode' }` — mode options are in `src/webview/scripts/core/state.ts`

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

| Task | File(s) | Skill/Instruction |
|------|---------|-------------------|
| Add a new VS Code setting | `package.json` + `src/config/settings.ts` + `src/views/settingsHandler.ts` + webview | `add-new-setting` skill |
| Add a new message type | `src/views/chatView.ts` + `src/webview/scripts/core/messageHandlers/` | `add-chat-message-type` skill |
| Add a new agent tool | `src/agent/toolRegistry.ts` + `src/views/toolUIFormatter.ts` | `add-agent-tool` skill |
| Modify chat UI | `src/webview/components/chat/` + `src/webview/scripts/core/` | `webview-ui` instructions |
| Modify model management UI | `src/webview/components/settings/components/ModelCapabilitiesSection.vue` + `src/services/sessionIndexService.ts` | `database-rules` + `extension-architecture` instructions |
| Change API behavior | `src/services/ollamaClient.ts` | `extension-architecture` instructions |
| Change inline completions | `src/providers/completionProvider.ts` | — |
| Modify agent prompts | `buildAgentSystemPrompt()` in `src/services/agentChatExecutor.ts` | `agent-tools` instructions |
| Message storage (LanceDB) | `src/services/databaseService.ts` | `database-rules` instructions |
| Session storage (SQLite) | `src/services/sessionIndexService.ts` | `database-rules` instructions |
| DB maintenance actions | `src/views/settingsHandler.ts` | `database-rules` instructions |
| Terminal command execution | `src/services/terminalManager.ts` + `src/utils/commandSafety.ts` | `agent-tools` instructions |
| File edit approval | `src/utils/fileSensitivity.ts` + `src/services/agentChatExecutor.ts` | `agent-tools` instructions |
| Write/edit instructions | `.github/instructions/` + `.github/skills/` | `copilot-custom-instructions` skill |
| Add a new test | `tests/extension/suite/` or `tests/webview/` | `add-test` skill |
