# Configuration

## Table of Contents

- [Settings Overview](#settings-overview)
- [Connection](#connection)
- [Mode-Specific Models](#mode-specific-models)
- [Agent Settings](#agent-settings)
- [Inline Completions](#inline-completions)
- [Model Capabilities](#model-capabilities)
- [Embeddings](#embeddings)
- [Storage](#storage)
- [Example Configurations](#example-configurations)

---

## Settings Overview

All settings live under the `ollamaCopilot.*` namespace. Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and search for "Ollama Copilot", or edit `settings.json` directly.

## Connection

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.baseUrl` | `http://localhost:11434` | Ollama or OpenWebUI server URL |
| `ollamaCopilot.bearerTokenConfigured` | `false` | Read-only indicator — use the `Set Bearer Token` command |
| `ollamaCopilot.contextWindow` | `16000` | Context window size in characters (~4000 tokens) |

`baseUrl` is the only setting that respects workspace scope — if set in workspace settings, it stays workspace-scoped on save. All other settings are saved globally.

## Mode-Specific Models

Each mode can use a different model. If left empty, the extension uses the first available model.

| Setting | Default | Used By |
|---------|---------|---------|
| `ollamaCopilot.completionMode.model` | `""` | Inline code completions |
| `ollamaCopilot.askMode.model` | `""` | Ask (chat) mode |
| `ollamaCopilot.editMode.model` | `""` | Edit mode |
| `ollamaCopilot.planMode.model` | `""` | Plan mode |
| `ollamaCopilot.agentMode.model` | `""` | Agent mode |

Each mode also has `temperature` and `maxTokens` settings:

| Mode | Temperature | Max Tokens | Notes |
|------|-------------|------------|-------|
| Completion | 0.1 | 500 | Low temp for predictable completions |
| Ask | 0.7 | 2048 | Higher temp for conversational responses |
| Edit | 0.3 | 4096 | Low-medium temp for focused edits |
| Plan | 0.5 | 4096 | Medium temp for planning |
| Agent | 0.4 | 8192 | Medium-low temp, high token limit for tool use |

## Agent Settings

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `ollamaCopilot.agent.maxIterations` | `25` | 5–100 | Max tool execution cycles per request |
| `ollamaCopilot.agent.toolTimeout` | `30000` | 5000–300000 | Tool timeout in milliseconds |
| `ollamaCopilot.agent.maxActiveSessions` | `1` | 1–5 | Max concurrent generating sessions |
| `ollamaCopilot.agent.enableThinking` | `true` | — | Enable chain-of-thought reasoning (`think: true` in Ollama API) |
| `ollamaCopilot.agent.sensitiveFilePatterns` | *(see below)* | — | Glob→boolean map for file edit approval |

### Sensitive File Patterns

Controls which files require manual approval before the agent can edit them. Format is a JSON object where keys are glob patterns and values are booleans:

- `true` = auto-approve (no confirmation needed)
- `false` = require approval (shows diff before applying)

**Last matching pattern wins.** Example:

```json
{
  "**/*": true,
  "**/.env*": false,
  "**/package.json": false
}
```

This auto-approves all files except `.env` files and `package.json`.

## Inline Completions

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.enableAutoComplete` | `true` | Enable/disable inline autocomplete |

Completions require a FIM (Fill-In-Middle) capable model. Recommended: `codellama:7b-code`, `deepseek-coder:6.7b`, `qwen2.5-coder:7b`.

## Model Capabilities

The **Models** tab in the settings page shows every downloaded model alongside its detected features:

| Column | Meaning |
|--------|---------|
| **On** | Enable/disable toggle — disabled models are hidden from all model selection dropdowns |
| **Chat** | Conversational chat — model has a chat template for multi-turn conversations |
| **Vision** | Image understanding (detected via `/api/show` capabilities) |
| **FIM** | Fill-In-Middle — required for inline code completions |
| **Tools** | Function/tool calling — required for agent mode |
| **Embed** | Embedding model — generates vector embeddings, cannot chat |

Capabilities are sourced from the **Ollama `/api/show` endpoint**, which returns a `capabilities` array for each model (e.g. `["completion", "vision", "tools"]`). The extension calls `/api/show` in parallel for every model when the model list is fetched and maps the results:

| API capability | UI column |
|---------------|-----------|
| `completion` | Chat |
| `vision` | Vision |
| `insert` | FIM |
| `tools` | Tools |
| `embedding` | Embed |

This is accurate for all models — no name-based heuristics or regex patterns are used.

### Model Enable/Disable

Each model can be toggled on or off using the checkbox in the **On** column. Disabled models are:
- Hidden from all model selection dropdowns (Agent, Ask, Edit, Completion)
- Still visible in the capabilities table (with a dimmed row style)

Use the **Enable All** / **Disable All** buttons below the table for bulk operations.

### Model Selection (Auto-Save)

The Model Selection section lets you assign a model to each mode (Agent, Ask, Edit, Completion). Only enabled models appear in the dropdowns. If no models are enabled, the dropdown shows "No enabled models".

Changes are **saved automatically** when you select a different model — there is no Save button.

### Stale Model Cleanup

When the model list is refreshed from Ollama (on startup, manual refresh, or connection test), the entire SQLite `models` table is replaced. Models that were deleted from Ollama are automatically removed from the cache.

### Offline Model Cache

The model list is persisted in SQLite every time it is successfully fetched from the Ollama server. If the server becomes unreachable (network error, bad token, server down), the extension falls back to the last cached list so that model dropdowns and the capabilities table remain populated.

The cache is updated automatically on:
- Extension activation (webview init)
- Clicking **Test Connection** in settings
- Clicking **↻ Refresh All** in the Models tab

## Embeddings

Used for semantic search in session history.

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.embedding.provider` | `builtin` | `builtin` (LanceDB sentence-transformers) or `ollama` |
| `ollamaCopilot.embedding.model` | `nomic-embed-text` | Ollama embedding model (when provider is `ollama`) |

## Storage

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.storagePath` | `""` (empty) | Custom absolute path for database storage. Leave empty for the default location, which is stable across single→multi-root workspace changes. **Requires window reload.** |

By default, databases are stored under `globalStorageUri/<sha256(firstWorkspaceFolderUri)>/`. This location is:
- **Workspace-isolated** — each project gets its own sessions, messages, and search index.
- **Stable across workspace identity changes** — adding a second folder to your workspace (converting single-root to multi-root) no longer orphans your data.

When upgrading from a previous version, databases at the old `context.storageUri` path are automatically copied to the new location on first activation.

## Example Configurations

### Minimal (local Ollama)

```json
{
  "ollamaCopilot.baseUrl": "http://localhost:11434",
  "ollamaCopilot.agentMode.model": "qwen2.5-coder:7b"
}
```

### Separate models per mode

```json
{
  "ollamaCopilot.baseUrl": "http://localhost:11434",
  "ollamaCopilot.completionMode.model": "codellama:7b-code",
  "ollamaCopilot.askMode.model": "qwen2.5-coder:7b",
  "ollamaCopilot.agentMode.model": "qwen2.5-coder:14b",
  "ollamaCopilot.agent.maxIterations": 30
}
```

### OpenWebUI

```json
{
  "ollamaCopilot.baseUrl": "https://your-openwebui.example.com"
}
```

Then run `Ollama Copilot: Set Bearer Token` to configure authentication. See [Authentication](authentication.md).
