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
| Ollama `ChatMessage` | `src/types/ollama.ts` | **API requests/responses** — wire format | `role`, `content`, `tool_calls?`, `tool_name?`, `thinking?` |

**When to use which:**
- Storing to or reading from the database → `MessageRecord`
- Sending to the webview via `postMessage` → `ChatMessage` (constructed by `chatSessionController.ts`)
- Sending to the Ollama API → `ChatMessage` from `src/types/ollama.ts` — includes `role`, `content`, and optionally `tool_calls` (assistant), `tool_name` (tool results), `thinking` (chain-of-thought)

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

Reads **model capabilities from the Ollama `/api/show` endpoint** which returns a `capabilities` string array (e.g. `["completion", "vision", "tools", "insert"]`). The module maps those API strings to the UI-facing `ModelCapabilities` type:

| API value | `ModelCapabilities` field |
|-----------|--------------------------|
| `completion` | `chat` |
| `insert` | `fim` |
| `tools` | `tools` |
| `vision` | `vision` |
| `embedding` | `embedding` |

No regex arrays or name-based heuristics are used. Capabilities are populated by `OllamaClient.fetchModelsWithCapabilities()`, which calls `listModels()` then `showModel()` in parallel for all models, merging the `capabilities` array into each `Model` object.

### SQLite Model Cache

The model list (name, size, family, quantization, capabilities, `enabled` flag) is persisted in the SQLite `models` table. Key behaviors:

- **Offline fallback**: When Ollama is unreachable, the extension reads the last cached model list so dropdowns and the capabilities table remain populated.
- **Stale cleanup**: `upsertModels()` does `DELETE FROM models` then re-inserts all models from the latest Ollama response. Models removed from Ollama are automatically dropped.
- **Enable/disable**: Each model has an `enabled INTEGER NOT NULL DEFAULT 1` column. Disabled models are filtered out of `modelOptions` in the webview. Bulk "Enable All" / "Disable All" toggles loop through `modelInfo` and call `toggleModelEnabled()` for each.
- **Auto-save**: The Model Selection dropdowns (`ModelCapabilitiesSection.vue`) auto-save on change via `@change="autoSave"` — no explicit Save button.

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

## PendingEditReviewService (`src/services/pendingEditReviewService.ts`)

Provides inline change review after the agent edits files — green/red line decorations, per-hunk CodeLens actions (Keep / Undo / ↑ / ↓), and file navigation.

### Lifecycle

```
Agent writes files → agentChatExecutor creates checkpoint + file snapshots
  → execute() returns { checkpointId } to handleAgentMode()
  → handleAgentMode() calls reviewService.startReviewForCheckpoint(checkpointId)
      → buildReviewSession(checkpointId)
          ├─ Reads file_snapshots from DB
          ├─ Diffs original_content vs current on-disk content (structuredPatch)
          ├─ Creates per-file decoration types + ReviewHunk[] arrays
          └─ Registers CodeLens provider (scheme: 'file')
      → Applies decorations to all visible editors that match reviewed files
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **ReviewSession** | One active session at a time, tied to a `checkpointId`. Contains array of `FileReviewState`. |
| **FileReviewState** | Per-file: URI, hunks[], decoration types, current hunk index |
| **ReviewHunk** | Contiguous diff region: `startLine`, `endLine`, `addedLines[]`, `deletedCount`, `originalText`, `newText` |
| **Auto-start** | `startReviewForCheckpoint()` is called automatically when agent finishes — decorations appear on already-open files without user action |
| **Manual start** | User clicks ✓ icon on a file in the widget → `openFileReview()` → opens file + applies decorations |
| **Hunk resolution** | `keepHunk()` removes the hunk from tracking. `undoHunk()` reverts the text via `editor.edit()`, then removes + shifts subsequent hunks by line delta. |

### Widget ↔ Review Service Coupling

The files-changed widget and the review service both track file change state independently. They sync via events:

| Direction | Mechanism | When |
|-----------|-----------|------|
| Widget → Review | `chatView.handleKeepFile()` calls `reviewService.removeFileFromReview(filePath)` | User clicks Keep/Undo in widget |
| Widget → Review | `chatView.handleKeepAllChanges()` calls `reviewService.closeReview()` | User clicks Keep All / Undo All |
| Review → Widget | `onDidResolveFile` event → chatView persists + posts `fileChangeResult` | All hunks in a file resolved via CodeLens |
| Review → Widget | `onDidUpdateHunkStats` event → chatView posts `filesDiffStats` | Any hunk keep/undo changes +/- counts |

### ⚠️ sessionId Resolution in File Change Handlers

The webview's `keepFile`, `undoFile`, `keepAllChanges`, `undoAllChanges` actions do **not** include `sessionId` in the `postMessage`. The backend handlers in `chatView.ts` must resolve it:

```typescript
private async handleUndoAllChanges(checkpointId: string, sessionId?: string) {
  const resolvedSessionId = sessionId || this.sessionController.getCurrentSessionId();
  // ... use resolvedSessionId for persistUiEvent
}
```

Without this, `persistUiEvent()` silently drops the event (`if (!sessionId) return`), and session history will be missing the keep/undo result — the widget reappears on reload.

## Checkpoint & Snapshot Architecture

### Data Model

Checkpoints and file snapshots are stored in SQLite (not LanceDB):

**`checkpoints` table:**
| Column | Type | Purpose |
|--------|------|---------|
| `id` | `TEXT PRIMARY KEY` | UUID, created at start of each agent execution |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `message_id` | `TEXT` | Associated message (nullable) |
| `status` | `TEXT` | `'pending'` → `'kept'` / `'undone'` / `'partial'` |
| `created_at` | `INTEGER` | Timestamp |

**`file_snapshots` table:**
| Column | Type | Purpose |
|--------|------|---------|
| `id` | `TEXT PRIMARY KEY` | UUID |
| `checkpoint_id` | `TEXT NOT NULL` | FK → checkpoints (CASCADE delete) |
| `file_path` | `TEXT NOT NULL` | Workspace-relative path |
| `original_content` | `TEXT` | Content BEFORE agent edit (NULL after kept+pruned) |
| `action` | `TEXT` | `'modified'` / `'created'` |
| `file_status` | `TEXT` | `'pending'` / `'kept'` / `'undone'` |
| `created_at` | `INTEGER` | Timestamp |
| **UNIQUE** | | `(checkpoint_id, file_path)` — INSERT OR IGNORE keeps first snapshot |

### Checkpoint Lifecycle

```
1. Agent loop starts → createCheckpoint(sessionId) → returns checkpointId
2. Before each write_file/create_file → snapshotFileBeforeEdit()
   └─ INSERT OR IGNORE (only first snapshot per file per checkpoint is kept)
3. Agent loop ends → filesChanged payload with checkpointId sent to webview
4. User actions:
   ├─ Keep file → updateFileSnapshotStatus('kept') + pruneCheckpointContent()
   ├─ Undo file → revert file on disk + updateFileSnapshotStatus('undone')
   ├─ Keep All → mark all 'kept' + prune
   └─ Undo All → revert all + mark 'undone'
5. All resolved → updateCheckpointStatus('kept'/'undone'/'partial')
```

### Snapshot Content Pruning

After a file is **kept**, its `original_content` is set to `NULL` via `pruneCheckpointContent()`. This saves storage since the original is no longer needed for undo. Undone files retain `original_content` for debugging.
