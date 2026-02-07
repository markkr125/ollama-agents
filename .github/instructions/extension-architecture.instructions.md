---
applyTo: "src/extension.ts,src/config/**,src/services/**,src/types/**"
description: "Extension-level architecture: type system, service initialization, config pattern, OllamaClient API, terminal manager, and model compatibility"
---

# Extension Architecture & Service Patterns

## Type System — Three Message Interfaces

The codebase has **three different interfaces** for messages. Using the wrong one is a common mistake:

| Interface | File | Role | Fields |
|-----------|------|------|--------|
| `MessageRecord` | `src/types/session.ts` | **Database persistence** — the source of truth | `snake_case`: `session_id`, `tool_name`, `tool_input`, `tool_output`, `progress_title` |
| `ChatMessage` | `src/views/chatTypes.ts` | **View layer transfer** — enriched with UI metadata | `camelCase`: `toolName`, `actionText`, `actionIcon`, `actionStatus` |
| Ollama wire format | `src/types/ollama.ts` | **API requests** — minimal | Only `role`, `content` |

**When to use which:**
- Storing to or reading from the database → `MessageRecord`
- Sending to the webview via `postMessage` → `ChatMessage` (constructed by `chatSessionController.ts`)
- Sending to the Ollama API → plain `{ role, content }` objects

**Gotcha**: `ChatSession` in `chatTypes.ts` is a **legacy type** — the real session record is `SessionRecord` in `types/session.ts`. Do not add new session fields to `ChatSession`.

**Gotcha**: `WebviewMessageEmitter` in `chatTypes.ts` is intentionally `any`-typed (`postMessage(message: any)`). The emitter is injected into `AgentChatExecutor`, `ChatSessionController`, and `SettingsHandler` — all post different message shapes. Do not try to make it generic/typed.

## Service Initialization Order

In `extension.ts → activate()`:

```
1. getConfig()                    ← reads VS Code settings (snapshot)
2. TokenManager(context)          ← creates secure storage accessor
3. OllamaClient(baseUrl, token)   ← HTTP client (no connections yet)
4. ModelManager(client)            ← model listing/caching
5. getDatabaseService(context)     ← singleton accessor
6. databaseService.initialize()    ← SQLite: EAGER (blocks activation)
                                     LanceDB: LAZY (background promise)
7. ChatViewProvider(...)           ← creates ToolRegistry, TerminalManager,
                                     ChatSessionController, SettingsHandler,
                                     AgentChatExecutor internally
8. testConnection() (fire-and-forget) ← non-blocking
```

**Key rule**: SQLite is ready after `initialize()` returns. LanceDB may still be initializing. Any code that needs LanceDB must call `await databaseService.ensureLanceReady()` which awaits the background promise.

## DatabaseService Singleton Pattern

```typescript
// First call — creates the singleton (must have context)
const db = getDatabaseService(context);

// Subsequent calls — returns existing singleton (context optional)
const db = getDatabaseService();

// Cleanup — must call on deactivate
disposeDatabaseService();
```

**Gotcha**: `disposeDatabaseService()` calls `close()` but **does not await it**. The `close()` method is async (awaits `lanceInitPromise`), but the dispose function fires and forgets. If you need clean shutdown (e.g., in tests), await `close()` directly.

**Embedding fallback**: `computeEmbedding()` uses a trivial character-hash vector when no embedding model is configured — deterministic but semantically meaningless. Good for dedup, not for semantic search.

## Configuration Pattern — Snapshots, Not Reactive

`getConfig()` in `src/config/settings.ts` reads VS Code configuration **on every call** and returns a fresh `ExtensionConfig` object. It's a snapshot, not a live reference.

```typescript
const config = getConfig();   // reads ALL settings right now
const mode = getModeConfig('agent'); // shortcut for config.agentMode
const agent = getAgentConfig();      // shortcut for config.agent
```

## Build Output Directories

Three output directories exist. **Never edit files in these directories** — they are overwritten on every build.

| Directory | Build Tool | Contains | Source |
|-----------|-----------|----------|--------|
| `dist/` | **Webpack** | Extension bundle (`extension.js`) — this is the runtime entry point (`"main"` in `package.json`) | `src/**` (excluding `src/webview/`) |
| `media/` | **Vite** | Webview bundle (`index.html`, `chatView.js`, `chatView.css`) — loaded by `ChatViewProvider` | `src/webview/**` |
| `out/` | **tsc** (`tsconfig.test.json`) | Compiled test files — used **only** by `@vscode/test-electron` runner | `tests/extension/**` |

**Common mistake**: Editing `media/chatView.js` or `dist/extension.js` directly. These changes are silently lost on the next `npm run compile`.

**Settings scope rule**: Only `baseUrl` respects workspace vs global scope (uses `config.inspect()` to detect existing scope). All other settings are always saved to `ConfigurationTarget.Global`.

## Settings Mapping Asymmetry

The webview uses **camelCase** keys, VS Code configuration uses **dot-separated** keys:

| Webview Payload Key | VS Code Setting Key |
|--------------------|--------------------|
| `agentModel` | `agentMode.model` |
| `askModel` | `askMode.model` |
| `editModel` | `editMode.model` |
| `completionModel` | `completionMode.model` |
| `maxIterations` | `agent.maxIterations` |
| `toolTimeout` | `agent.toolTimeout` |
| `maxActiveSessions` | `agent.maxActiveSessions` |
| `sensitiveFilePatterns` | `agent.sensitiveFilePatterns` |
| `enableAutoComplete` | `enableAutoComplete` |
| `temperature` | `agentMode.temperature` |

Both `getSettingsPayload()` and `saveSettings()` in `settingsHandler.ts` manually map between these. When adding a new setting, **both** functions must be updated.

## OllamaClient API Patterns

### Streaming
Both `chat()` and `generate()` return `AsyncGenerator`. Responses are NDJSON (newline-delimited JSON). The NDJSON parser silently swallows parse errors.

### Error Hierarchy
```
OllamaError           ← base class (has statusCode)
├── ConnectionError   ← network failures (TypeError)
└── AuthError         ← HTTP 401
```

### Retry Policy
- **3 attempts** with exponential backoff (1s, 2s, 4s)
- **Auth errors (401) are never retried** — thrown immediately
- Only server errors (5xx) and connection failures trigger retry

### Base URL
Trailing slash is always stripped (both in constructor and `setBaseUrl()`).

### `testConnection()`
Returns `boolean`, not the error — swallows exceptions. The `SettingsHandler.testConnection()` wrapper sends results to the UI via `connectionTestResult` message.

## Terminal Manager (`src/services/terminalManager.ts`)

### Shell Integration Requirement
**Requires VS Code Terminal Shell Integration** (VS Code 1.93+, `vscode.env.shell`). On initialization, waits up to 5 seconds for shell integration to appear. If unavailable, throws a hard error. This drives the `engines.vscode: ^1.93.0` requirement in `package.json`.

### Session-Keyed Terminals
Terminals are **keyed by session ID**, not by command or CWD. One terminal per agent session, reused across commands. Terminals are auto-cleaned when VS Code closes them (via `onDidCloseTerminal` listener).

### Output Truncation
Output is hard-truncated to **100 lines** (15 head + 85 tail) with a `[N lines truncated]` marker. ANSI escape sequences and VS Code's `]633;` shell integration markers are stripped.

### Execution Caveat
`waitForCommandEnd()` relies on the `onDidEndTerminalShellExecution` event. If the event never fires (e.g., shell integration bug), the promise **never resolves**. There is no timeout.

## Model Compatibility (`src/services/modelCompatibility.ts`)

Uses **hard-coded regex arrays** to detect model capabilities by name:
- `TOOL_USE_CAPABLE_PATTERNS` — models that support function calling
- `FIM_CAPABLE_PATTERNS` — models that support fill-in-the-middle

**Known limitation**: Lists are manually maintained and lag behind new model releases. They include `llama3.[123]` but don't cover `llama4`, `deepseek-v3`, `phi-4`, etc. If you add support for a new model, add its pattern to the appropriate array.

## File Sensitivity (`src/utils/fileSensitivity.ts`)

### Pattern Evaluation: Last-Match-Wins
`evaluateFileSensitivity()` iterates the `sensitiveFilePatterns` object **in insertion order**. The **last matching pattern wins**:
```json
{ "**/*": true, "**/.env*": false }
```
- `**/*` matches everything → `true` (auto-approve)
- `**/.env*` matches `.env` → `false` (require approval) ← wins because it's last

**Value semantics**: `true` = auto-approve (NOT sensitive), `false` = require approval (sensitive). The boolean is inverted from what the key name "sensitive" suggests.

### Session-Level Overrides
Each session can have its own `sensitive_file_patterns` (stored as JSON string in the `sensitive_file_patterns` SQLite column). Session patterns take precedence over the global `agent.sensitiveFilePatterns` setting.

## Auto-Approve: Two Independent Toggles

| Toggle | DB Column | Controls |
|--------|-----------|----------|
| `auto_approve_commands` | `auto_approve_commands` | Terminal command execution |
| `auto_approve_sensitive_edits` | `auto_approve_sensitive_edits` | File edits to sensitive files |

These are stored per-session and toggled independently. **Critical severity commands always require approval** regardless of `auto_approve_commands` — this is enforced in `terminalApproval.ts`.

## Deactivation

`deactivate()` in `extension.ts`:
1. Resets all `generating` sessions to `idle` (so they don't appear stuck on reload)
2. Disposes `OllamaClient` (cancels pending HTTP)
3. Clears `ModelManager` cache
4. Calls `disposeDatabaseService()` (fire-and-forget, not awaited)
