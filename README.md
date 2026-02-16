# Ollama Copilot

AI-powered code completion and chat assistance using local [Ollama](https://ollama.ai) or [OpenWebUI](https://github.com/open-webui/open-webui). A free, open-source VS Code extension that runs entirely on your machine — no cloud, no telemetry, no subscription.

## Features

- **Inline Code Completions** — real-time ghost-text suggestions as you type, powered by FIM-capable models
- **Chat Sidebar** — Copilot-style sidebar chat with persistent sessions, search, and markdown rendering
- **Agent Mode** — autonomous coding agent that reads/writes files, runs terminal commands, spawns sub-agents, and iterates until the task is done
- **Plan Mode** — read-only planning with "Start Implementation" handoff to Agent mode
- **Chat Mode** — general Q&A about code (replaces former Ask and Edit modes)
- **Slash Commands** — `/review` and `/security-review` for on-demand code review
- **Command Approval** — terminal commands and sensitive file edits require explicit approval with editable commands and side-by-side diffs
- **Files Changed Widget** — review all agent-modified files with per-file diff stats, Keep/Undo actions, and cross-file hunk navigation
- **Inline Change Review** — green/red line decorations with CodeLens Keep/Undo/Navigate actions directly in the editor
- **Session History** — all conversations stored locally with SQLite (sessions) and LanceDB (messages + semantic search)
- **OpenWebUI Support** — connect to remote instances with bearer token authentication (stored in VS Code's encrypted secret storage)

## Quick Start

1. Install and start Ollama:
   ```bash
   curl -fsSL https://ollama.ai/install.sh | sh
   ollama serve
   ```

2. Pull a model:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```

3. Install the extension (from source):
   ```bash
   git clone https://github.com/markkr125/ollama-agents.git
   cd ollama-copilot
   npm install
   npm run compile
   ```

4. Press **F5** in VS Code to launch the Extension Development Host

5. Click the robot icon in the Activity Bar to open the chat sidebar

See [docs/getting-started.md](docs/getting-started.md) for the full setup guide.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Install Ollama, install the extension, first-run setup |
| [Configuration](docs/configuration.md) | All settings, per-mode config, model recommendations |
| [Authentication](docs/authentication.md) | Bearer tokens for OpenWebUI |
| [Chat & Modes](docs/chat-and-modes.md) | Agent, Plan, and Chat modes, slash commands, sub-agents |
| [Testing](docs/testing.md) | Dual-harness architecture, running tests, adding tests |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and how to fix them |

## Commands

| Command | Description |
|---------|-------------|
| `Ollama Copilot: Select Model` | Choose the active model |
| `Ollama Copilot: Set Bearer Token` | Configure OpenWebUI authentication |
| `Ollama Copilot: Setup Wizard` | Open the settings page |
| `Ollama Copilot: Edit with Instructions` | Transform selected code with AI |

## Requirements

- **VS Code** ≥ 1.93.0
- **Ollama** running locally — or a remote OpenWebUI instance
- **Node.js** ≥ 20 (for building from source)

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build webview (Vite) + extension (Webpack)
npm run watch        # Watch mode for development
npm run test:all     # Run all tests (Vitest + extension host)
npm run lint:all     # Lint: ESLint + docs structure + naming conventions
npm run lint:fix     # ESLint auto-fix
npm run package      # Package as .vsix
```

Press **F5** to launch the Extension Development Host with the extension loaded.

## License

MIT
