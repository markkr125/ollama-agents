# Getting Started

## Table of Contents

- [Prerequisites](#prerequisites)
- [Install Ollama](#install-ollama)
- [Pull a Model](#pull-a-model)
- [Install the Extension](#install-the-extension)
- [First-Run Setup](#first-run-setup)

---

## Prerequisites

- **VS Code** 1.93.0 or higher
- **Node.js** 20.x or higher (for building from source)
- **Ollama** installed and running — or a remote OpenWebUI instance

## Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.ai/install.sh | sh

# Or download the installer from https://ollama.ai
```

Start the server:

```bash
ollama serve
```

Verify it's running:

```bash
curl http://localhost:11434/api/tags
```

## Pull a Model

You need at least one model. Pick one based on your hardware:

| Model | Size | Good For |
|-------|------|----------|
| `qwen2.5-coder:7b` | ~4.7 GB | Balanced quality/speed, tool-capable |
| `codellama:7b-code` | ~3.8 GB | Fast inline completions |
| `deepseek-coder:6.7b` | ~3.8 GB | High quality completions |
| `qwen2.5-coder:14b` | ~9 GB | Better agent performance (needs 16 GB+ RAM) |

```bash
ollama pull qwen2.5-coder:7b
```

## Install the Extension

### From source (development)

```bash
git clone https://github.com/your-username/ollama-copilot.git
cd ollama-copilot
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

### From VSIX (packaged)

```bash
npm run package
code --install-extension ollama-copilot-0.1.0.vsix
```

## First-Run Setup

On first launch, the extension opens the **Settings page** in the sidebar automatically.

1. Click the **Ollama Copilot** icon in the Activity Bar (robot icon)
2. Verify the **Base URL** is `http://localhost:11434` (or your OpenWebUI URL)
3. Select a model from the **Model** dropdown
4. Click **Test Connection** to confirm everything works

If you're using OpenWebUI with authentication, see the [Authentication](authentication.md) guide.

For all available settings, see the [Configuration](configuration.md) reference.
