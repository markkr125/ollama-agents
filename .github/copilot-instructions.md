# Ollama Copilot - Project Instructions

> **Scoped instructions & skills**: This file contains project-wide rules only. File-specific details live in scoped instruction files that are automatically loaded when editing matching files. See the full list below.
>
> | File | Scope (`applyTo`) | Content |
> |------|-------------------|---------|
> | `.github/instructions/database-rules.instructions.md` | `src/services/database/**,src/views/settingsHandler.ts` | Dual-DB design, schema mismatch, LanceDB corruption, message ordering, clearing data |
> | `.github/instructions/ui-messages.instructions.md` | `src/views/**,src/webview/**` | Backend↔frontend message protocol (full type tables), chat view structure, streaming behavior |
> | `.github/instructions/webview-ui.instructions.md` | `src/webview/**` | Assistant thread structure, CSS theming, diff2html, Vue patterns, session UX |
> | `.github/instructions/testing.instructions.md` | `tests/**` | Test harnesses, coverage catalogs, webview test rules |
> | `.github/instructions/agent-tools.instructions.md` | `src/agent/**,src/utils/toolCallParser.ts` | Agent execution flow, tool registry, tool call parser, terminal execution, command safety, approval flow |
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
| `filesChanged` | After agent loop emits changed files | `{ checkpointId, files, status }` |
| `fileChangeResult` | After single file keep/undo | `{ checkpointId, filePath, action, success }` |
| `keepUndoResult` | After Keep All / Undo All | `{ checkpointId, action, success }` |

### Debugging Live vs History Mismatch

If live chat shows something that session history doesn't:
1. **Check if the event is being persisted** - search for `persistUiEvent` near the `postMessage` call
2. **Check the `sessionId` is defined** - `persistUiEvent` silently returns if `sessionId` is `undefined`. Webview `postMessage` payloads often omit `sessionId` — the backend handler must resolve it via `sessionController.getCurrentSessionId()`
3. **Check the order** - events must be persisted in the same order they're posted
4. **Check timelineBuilder.ts** - the handler for that `eventType` must reconstruct the UI correctly

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

These are the mistakes most frequently made when editing this codebase. Each pitfall has full details in the scoped instruction file listed. **Check the relevant scoped file before submitting changes.**

| # | Pitfall (one-liner) | Scoped file |
|---|---------------------|-------------|
| 1 | Don't import `vscode` in `src/webview/**` — runtime crash | `webview-ui` |
| 2 | Don't edit `media/`, `dist/`, `out/` — build outputs | `extension-architecture` |
| 3 | `streamChunk` content is accumulated (replace, don't append) | `ui-messages` |
| 4 | `isPathSafe()` returns `true` = safe (no approval needed) | `agent-tools` |
| 5 | Don't add logic to `chatView.ts` — delegate to message handlers | `extension-architecture` |
| 6 | `sensitiveFilePatterns`: `true` = auto-approve, `false` = require approval | `agent-tools` |
| 8 | Vue lifecycle hooks silently fail outside `<script setup>` blocks | `webview-ui` |
| 9 | Stub `acquireVsCodeApi` before importing webview modules in tests | `testing` |
| 10 | `out/` = test compilation only; `dist/` = extension runtime (webpack) | `extension-architecture` |
| 12 | Never include `thinking` on assistant messages in conversation history | `agent-tools` |
| 14 | Merge `filesChanged` by `checkpointId`, don't push duplicates | `webview-ui` |
| 15 | Spread reactive arrays before `postMessage()` (`DataCloneError`) | `webview-ui` |
| 16 | Use `AsyncMutex` for concurrent review session builds | `extension-architecture` |
| 17 | Don't rebuild review session on every `navigateChange` call | `extension-architecture` |
| 18 | Call `sendSessionsList()` after agent/chat completes | `extension-architecture` |
| 19 | `ensureFilesChangedWidget()` is the safety net for missing `__ui__` events | `extension-architecture` |
| 20 | Use `filter()` + reassignment, not `splice()` on nested reactive arrays | `webview-ui` |
| 21 | Optimistic UI: remove file in click handler before `postMessage` | `webview-ui` |
| 22 | Send `requestFilesDiffStats` on re-edits, not just new files | `webview-ui` |
| 23 | Send `reviewChangePosition` after keep/undo file | `extension-architecture` |
| 24 | Preserve `currentFileIndex` when review session rebuilds | `extension-architecture` |
| 25 | `asRelativePath(path, true)` prefixes folder name — handle 3 sub-cases | `agent-tools` |
| 26 | Pass `collapse = false` to `closeActiveThinkingGroup()` at end of generation | `webview-ui` |
| 27 | Context labels must be descriptive to prevent agent re-reading files | `agent-tools` |
| 28 | Use `resolveStoragePath()`, not `context.storageUri` for DB storage | `database-rules` |
| 29 | Agent multi-iteration streaming: use `iterationBoundary` to prevent overwrite | `ui-messages` |
| 30 | Dedup context by both basename and relative path (format mismatch) | `webview-ui` |
| 31 | Call `editorContextTracker.sendNow()` on `ready` message | `extension-architecture` |
| 34 | Sub-agent emitter must filter `finalMessage` to prevent stream reset | `agent-tools` |
| 35 | Use `buildToolCallSummary()` for thinking model content, not empty string | `agent-tools` |
| 38 | `[Reasoning completed]` only for no-tool iterations; use tool summary otherwise | `agent-tools` |

### Pitfalls Without Scoped Coverage

The following pitfalls are only documented here:

**#11 — Restructuring `.github/instructions/`, `.github/skills/`, or `docs/`**: The preamble table in this file, `docs/README.md` index, and `npm run lint:docs` all validate structure. Renaming, moving, or deleting these files breaks cross-references. Run `npm run lint:docs` after any change. Keep the preamble table, docs index, and frontmatter in sync.

**#33 — Deleting composable functions silently kills components**: If a function returned from `useChatPage()` (or any composable) is deleted but still referenced in the `return` statement, the `ReferenceError` crashes the entire component at runtime. Vue silently replaces the component with empty content — no visible error unless Developer Tools are open. TypeScript/Vite do NOT catch this at compile time. The `app.config.errorHandler` in `main.ts` now shows a red error overlay in the webview. The `chatComposable.test.ts` smoke test verifies all returned members are defined. **Always run the composable smoke test after editing composable return statements.**

---

## Project Overview

**Ollama Copilot** is a VS Code extension that provides GitHub Copilot-like AI assistance using local Ollama or OpenWebUI as the backend. It's designed to be a fully local, privacy-preserving alternative to cloud-based AI coding assistants.

### Key Features
- **Inline Code Completion** - Autocomplete suggestions as you type
- **Chat Interface** - GitHub Copilot-style sidebar chat with 3 modes (Agent, Plan, Chat)
- **Agent Mode** - Autonomous coding agent that can read/write files, search, run commands, and spawn sub-agents
- **Plan Mode** - Tool-powered multi-step implementation planning with "Start Implementation" handoff
- **Chat Mode** - Tool-powered Q&A about code with read-only code intelligence tools (replaces former Ask and Edit modes)
- **Slash Commands** - `/review`, `/security-review`, and `/deep-explore` for on-demand code review and deep exploration in any mode

---

## Architecture

> Per-file annotations live in the scoped instruction files (loaded automatically). This tree shows folder structure only.

```
src/
├── extension.ts          # Entry point — ServiceContainer + phased init
├── agent/                # Agent tools, execution engine, git ops, sessions
│   ├── execution/        # Decomposed executor (see agent-tools instructions)
│   │   ├── orchestration/   # Core loop + intent routing
│   │   ├── streaming/       # LLM streaming + context management
│   │   ├── prompts/         # System prompt assembly
│   │   ├── toolExecution/   # Tool batch execution + lifecycle
│   │   └── approval/        # Approval flow + safety
│   └── tools/            # Individual tool implementations
│       ├── filesystem/       # File system tools + path resolution (includes findFiles.ts for glob search)
│       └── lsp/              # LSP-powered code intelligence tools
├── completion/           # Inline code completion (FIM)
├── config/               # Configuration helpers
├── modes/                # Mode command registration (agent, edit, plan)
├── services/             # Core services
│   ├── database/             # SQLite + LanceDB persistence
│   ├── model/                # Ollama HTTP client + model management
│   └── review/               # Inline change review (CodeLens)
├── types/                # TypeScript type definitions
├── utils/                # Shared utilities
├── views/                # Backend webview lifecycle + message routing
│   └── messageHandlers/      # IMessageHandler implementations (one per concern)
└── webview/              # Vue frontend (built by Vite)
    ├── components/           # Vue UI components (page-per-folder pattern)
    ├── scripts/              # App logic split by concern
    └── styles/               # SCSS

tests/
├── extension/            # @vscode/test-electron + Mocha
└── webview/              # Vitest + jsdom + Vue Test Utils
```

---

## Agent Mode Request Lifecycle

> The full agent mode lifecycle diagram is documented in `agent-tools.instructions.md` → "Agent Execution Flow".

**Key invariants** (non-negotiable):
- Every `postMessage` to the webview has a matching `persistUiEvent` to the database, in the same order (CRITICAL RULE #1).
- `filesChanged`, `fileChangeResult`, and `keepUndoResult` events must also be persisted. The backend handler must resolve `sessionId` from `sessionController.getCurrentSessionId()` when the webview doesn't provide it.

## Core Components

> Core component details (Type System, OllamaClient, ChatViewProvider, Settings, Model Management) are documented in `extension-architecture.instructions.md`.

## Agent Execution Engine

> The agent executor decomposition (18-file table + file map) is documented in `agent-tools.instructions.md` → "Agent Executor Architecture".

**Anti-pattern**: Do NOT add streaming, tool execution, or summary generation logic directly to `agentChatExecutor.ts`. Add it to the appropriate sub-handler or create a new one.

---

## ⚠️ CRITICAL RULE #4: Document As You Build

**Every feature addition, behavior change, or improvement MUST include corresponding updates to instructions and skills files.** Code changes without documentation updates are incomplete — treat docs the same as tests: the work is not done until both are updated.

### What to Update

When you add or change code, ask: *"Would an LLM editing this area next week need to know about this change?"* If yes, update the docs.

| What Changed | Update These Files |
|---|---|
| New agent tool | `agent-tools.instructions.md` (tool table + section), `copilot-instructions.md` (architecture tree + key files table), `docs/chat-and-modes.md` (available tools table), `add-agent-tool` skill (if new patterns) |
| New message type | `ui-messages.instructions.md` (message tables), `webview-ui.instructions.md` (if UI structure affected) |
| New setting | `extension-architecture.instructions.md`, `docs/configuration.md` |
| New/changed UI behavior | `webview-ui.instructions.md`, `ui-messages.instructions.md` |
| New test patterns | `testing.instructions.md` (test catalog + conventions) |
| New database table/column | `database-rules.instructions.md` (schema section) |
| New service or file | `copilot-instructions.md` (architecture tree), relevant scoped instructions |
| New pitfall discovered | `copilot-instructions.md` (Common Pitfalls table — assign next number) |
| Changed instructions/skills | `copilot-instructions.md` (preamble table if scope/description changed) |

### How to Find the Right File

1. Check the **preamble table** at the top of this file — it maps `applyTo` globs to instruction files
2. Check the **Key Files for Common Tasks** table at the bottom — it maps tasks to files + skills
3. When in doubt, update BOTH the scoped instruction file AND this root file

### Rules

- **Update the relevant scoped file** (`.github/instructions/*.instructions.md` or `.github/skills/*/SKILL.md`), not just this root file
- **Do not defer documentation** — update docs in the same session as the code change, not "later"
- **Run `npm run lint:docs`** after any docs/instructions/skills change to verify structure
- **Keep the preamble table in sync** if you add, rename, or change the scope of an instruction or skill file

---

## Development Guidelines

### Critical Meta (Non-Negotiable)

- **⚠️ Documentation is mandatory, not optional.** See CRITICAL RULE #4 above. Every code change that affects behavior, APIs, message types, settings, tools, or UI contracts MUST include updates to the relevant `.github/instructions/*.instructions.md`, `.github/skills/*/SKILL.md`, and/or `docs/*.md` files. If you skip this, the next person (human or LLM) working on this code will introduce bugs because they won't know about the change.
- Build or update automated tests whenever features are added/updated.
  - Use Vitest for webview core logic/components (`tests/webview`).
  - Use `@vscode/test-electron` for VS Code/extension integration (`tests/extension`).
  - **⚠️ Both harnesses are mandatory**: When a change spans backend AND frontend, write tests in BOTH `tests/extension/` (Mocha) AND `tests/webview/` (Vitest). Skipping either harness is not acceptable. See `testing.instructions.md` → "Both Harnesses Are Mandatory" for the full rule and examples.
  - A type-check (`tsc --noEmit`) passing does NOT mean tests pass. Always **run** the tests.
- Do not land changes unless the project is green:
  - Run `npm run test:all` locally when practical.
  - CI must pass (webview tests + extension-host tests).

### Post-Change Verification (Required)

After **any** code change, run through this checklist:

1. **Compile check**: `npm run compile` — must exit 0 (builds both webview via Vite and extension via webpack)
2. **Type check tests**: `npx tsc -p tsconfig.test.json --noEmit` — ensures test files still compile against changed source
3. **Lint check**: `npm run lint:all` — must exit 0 (ESLint + docs structure + naming conventions)
4. **Run ALL tests** — `npm run test:all` — runs both webview (Vitest) and extension host (Mocha) tests sequentially. **Always run both harnesses.** A type-check passing does NOT mean tests pass. `npm run test:webview` alone is NOT sufficient when backend code changed — you MUST also run `npm test` (extension host e2e tests).
5. **Check for regressions**: If you modified a message type, verify both the live handler (in `messageHandlers/`) and `timelineBuilder.ts` still agree
6. **Verify no stale imports**: If you moved or renamed a file, search for old import paths across the codebase

### Naming Conventions (Enforced by `npm run lint:naming`)

| Target | Convention | Example |
|--------|------------|---------|
| Folders | camelCase | `messageHandlers/`, `core/` |
| `.ts` files | camelCase | `chatView.ts`, `toolCallParser.ts` |
| `.vue` files | PascalCase | `ChatPage.vue`, `HeaderBar.vue` |
| `.test.ts` files | mirrors source | `chatView.test.ts`, `MarkdownBlock.test.ts` |
| `.scss` partials | `_kebab-case` | `_chat-input.scss`, `_variables.scss` |
| Special exemptions | — | `index.ts`, `main.ts`, `setup.ts`, `App.ts`, `App.vue`, `styles.scss` |

The naming linter (`scripts/lint-naming.js`) walks `src/` and `tests/` and exits non-zero on any violation. It runs as part of `npm run lint:all`.

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

# Lint — all checks (ESLint + docs structure + naming conventions)
npm run lint:all

# Lint — ESLint only (with auto-fix)
npm run lint:fix

# Lint — naming conventions only
npm run lint:naming

# Lint — docs structure only
npm run lint:docs

# Package extension
vsce package
```

### Running Tests

```bash
# Run ALL tests (ALWAYS do this before pushing)
npm run test:all

# Webview unit tests only (Vitest — fast, no VS Code host)
npm run test:webview

# Extension host e2e tests only (Mocha — launches VS Code + mock server)
npm test

# Type-check test files (does NOT execute tests — compile check only)
npx tsc -p tsconfig.test.json --noEmit
```

**⚠️ `npm run test:webview` alone is NEVER sufficient when backend code changed.** Always run `npm test` (or `npm run test:all`) to exercise the extension host tests. See `testing.instructions.md` for full rules.

---

## Key Files for Common Tasks

| Task | File(s) | Skill/Instruction |
|------|---------|-------------------|
| Add a new VS Code setting | `package.json` + `src/config/settings.ts` + `src/views/settingsHandler.ts` + webview | `add-new-setting` skill |
| Add a new message type | `src/views/messageHandlers/` (backend) + `src/webview/scripts/core/messageHandlers/` (frontend) | `add-chat-message-type` skill |
| Add a new agent tool | `src/agent/tools/` + `src/agent/tools/index.ts` + `src/views/toolUIFormatter.ts` + `src/agent/execution/toolExecution/agentToolRunner.ts` | `add-agent-tool` skill |
| Modify chat UI | `src/webview/components/chat/` + `src/webview/scripts/core/` | `webview-ui` instructions |
| Modify model management UI | `src/webview/components/settings/components/features/ModelCapabilitiesSection.vue` + `src/services/database/sessionIndexService.ts` | `database-rules` + `extension-architecture` instructions |
| Change API behavior | `src/services/model/ollamaClient.ts` | `extension-architecture` instructions |
| Change inline completions | `src/completion/completionProvider.ts` | — |
| Modify agent prompts | `src/agent/execution/prompts/agentPromptBuilder.ts` | `agent-tools` instructions |
| Modify agent intent classification | `src/agent/execution/orchestration/agentDispatcher.ts` + `src/types/agent.ts` (`TaskIntent`, `DispatchResult`) | `agent-tools` instructions → "Agent Dispatcher — Intent Classification" |
| Modify agent streaming | `src/agent/execution/streaming/agentStreamProcessor.ts` | `agent-tools` instructions |
| Modify agent tool execution | `src/agent/execution/toolExecution/agentToolRunner.ts` | `agent-tools` instructions |
| Modify agent summary/finalization | `src/agent/execution/toolExecution/agentSummaryBuilder.ts` | `agent-tools` instructions |
| Explorer model resolution | `src/agent/execution/orchestration/agentChatExecutor.ts` (`resolveExplorerCapabilities`) + `src/views/messageHandlers/chatMessageHandler.ts` (3-tier fallback) + `src/config/settings.ts` + `package.json` | `agent-tools` instructions → "Explorer Model Resolution" |
| Per-session explorer override | `src/views/chatSessionController.ts` + `src/webview/components/chat/components/SessionControls.vue` + `src/services/database/sessionRepository.ts` | `agent-tools` + `webview-ui` instructions |
| Message storage (LanceDB) | `src/services/database/lanceSearchService.ts` + `src/services/database/databaseService.ts` | `database-rules` instructions |
| Session storage (SQLite) | `src/services/database/sessionIndexService.ts` | `database-rules` instructions |
| Storage path resolution | `src/services/database/storagePath.ts` (`resolveStoragePath`, `migrateIfNeeded`, `workspaceKey`) | `database-rules` instructions |
| DB maintenance actions | `src/views/settingsHandler.ts` | `database-rules` instructions |
| Terminal command execution | `src/services/terminalManager.ts` + `src/agent/execution/approval/commandSafety.ts` | `agent-tools` instructions |
| File edit approval | `src/utils/fileSensitivity.ts` + `src/agent/execution/approval/agentFileEditHandler.ts` | `agent-tools` instructions |
| Inline change review (CodeLens) | `src/services/review/pendingEditReviewService.ts` (facade) + `reviewSessionBuilder.ts` + `reviewDecorationManager.ts` | `extension-architecture` instructions |
| Cross-file change navigation | `src/services/review/reviewNavigator.ts` (pure math) + `pendingEditReviewService.ts` (side effects) + `FilesChanged.vue` (nav bar UI) | `extension-architecture` + `webview-ui` instructions |
| Session stats badge (pending +/-) | `src/services/database/sessionIndexService.ts` (`getSessionsPendingStats`) + `src/views/chatSessionController.ts` (`sendSessionsList`) | `database-rules` + `extension-architecture` instructions |
| Files changed widget | `src/webview/components/chat/components/FilesChanged.vue` + `src/webview/scripts/core/actions/filesChanged.ts` + `src/webview/scripts/core/messageHandlers/filesChanged.ts` | `webview-ui` + `ui-messages` instructions |
| Checkpoint/snapshot management | `src/services/database/sessionIndexService.ts` (tables) + `src/agent/execution/toolExecution/checkpointManager.ts` (lifecycle) | `database-rules` + `agent-tools` instructions |
| Agent path resolution | `src/agent/tools/filesystem/pathUtils.ts` (`resolveMultiRootPath`, `resolveWorkspacePath`) | `agent-tools` instructions |
| User-provided context pipeline | `src/views/editorContextTracker.ts` → `src/webview/scripts/core/actions/input.ts` → `src/views/messageHandlers/chatMessageHandler.ts` → `src/agent/execution/orchestration/agentChatExecutor.ts` (`buildAgentSystemPrompt`) | `agent-tools` instructions → "User-Provided Context Pipeline" |
| LSP pre-analysis + symbol map | `src/views/messageHandlers/chatMessageHandler.ts` (LSP resolution) → `src/agent/execution/orchestration/agentChatExecutor.ts` (`extractSymbolMap`, `extractUserContextBlocks`) | `agent-tools` instructions |
| LSP code intelligence tools | `src/agent/tools/lsp/{findDefinition,findReferences,findSymbol,getDocumentSymbols,getHoverInfo,getCallHierarchy,findImplementations,getTypeHierarchy}.ts` | `agent-tools` instructions |
| LSP symbol position resolution | `src/agent/tools/lsp/symbolResolver.ts` (`resolveSymbolPosition`, `formatLocation`) | `agent-tools` instructions |
| UI file opening from tool results | `src/views/messageHandlers/fileChangeMessageHandler.ts` (`handleOpenWorkspaceFile`, `stripFolderPrefix`) + `src/webview/components/chat/components/timeline/ProgressGroup.vue` (click handlers) | `webview-ui` instructions |
| Tool UI formatting | `src/views/toolUIFormatter.ts` (maps tool names/output → icons, text, listing format) | `agent-tools` + `webview-ui` instructions |
| Token usage indicator | `src/webview/components/chat/components/input/TokenUsageIndicator.vue` + `src/webview/scripts/core/messageHandlers/streaming.ts` (`handleTokenUsage`) + `src/agent/execution/streaming/agentContextCompactor.ts` (`estimateTokensByCategory`) | `ui-messages` + `webview-ui` + `extension-architecture` instructions |
| Model context window detection | `src/services/model/modelCompatibility.ts` (`extractContextLength`) + `src/services/database/sessionIndexService.ts` (`context_length` column) + `src/services/model/ollamaClient.ts` (`fetchModelsWithCapabilities`) | `extension-architecture` instructions |
| Running models (API /api/ps) | `src/services/model/ollamaClient.ts` (`getRunningModels`) | `extension-architecture` instructions |
| Write/edit instructions | `.github/instructions/` + `.github/skills/` | `copilot-custom-instructions` skill |
| Add a new test | `tests/extension/suite/` or `tests/webview/` | `add-test` skill |
