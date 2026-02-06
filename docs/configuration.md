# Configuration

## Table of Contents

- [Settings Overview](#settings-overview)
- [Connection](#connection)
- [Mode-Specific Models](#mode-specific-models)
- [Agent Settings](#agent-settings)
- [Inline Completions](#inline-completions)
- [Embeddings](#embeddings)
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

## Embeddings

Used for semantic search in session history.

| Setting | Default | Description |
|---------|---------|-------------|
| `ollamaCopilot.embedding.provider` | `builtin` | `builtin` (LanceDB sentence-transformers) or `ollama` |
| `ollamaCopilot.embedding.model` | `nomic-embed-text` | Ollama embedding model (when provider is `ollama`) |

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
