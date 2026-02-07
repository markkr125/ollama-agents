# Troubleshooting

## Table of Contents

- [Connection Issues](#connection-issues)
- [Model Issues](#model-issues)
- [Inline Completions](#inline-completions)
- [Agent Mode](#agent-mode)
- [Session & Data Issues](#session--data-issues)
- [Getting Debug Logs](#getting-debug-logs)

---

## Connection Issues

### "Cannot connect to Ollama"

1. Ensure Ollama is running:
   ```bash
   ollama serve
   ```
2. Verify the URL responds:
   ```bash
   curl http://localhost:11434/api/tags
   ```
3. Check `ollamaCopilot.baseUrl` in settings — should be `http://localhost:11434` (no trailing slash)
4. If using a remote server, check firewall rules and network connectivity

### "Invalid bearer token"

- Re-enter the token: run `Ollama Copilot: Set Bearer Token` from the Command Palette
- Verify the token in OpenWebUI → Settings → API Keys
- See [Authentication](authentication.md) for details

### Connection test passes but features don't work

- Reload the VS Code window (`Developer: Reload Window`)
- Check the Output panel for errors (see [Getting Debug Logs](#getting-debug-logs))

## Model Issues

### No models in dropdown

- Pull at least one model: `ollama pull qwen2.5-coder:7b`
- Verify models are available: `ollama list`
- Click "Test Connection" in settings to refresh

### Agent not using tools

The model may not support function calling. Use a tool-capable model like `qwen2.5-coder:7b` or larger. Smaller or older models may not reliably produce tool calls.

## Inline Completions

### No completions appearing

1. Check that a completion model is set in settings (`completionMode.model`)
2. Verify the model supports FIM (Fill-In-Middle) — `codellama:*-code`, `deepseek-coder:*`, `qwen2.5-coder:*` all support FIM
3. Check that `ollamaCopilot.enableAutoComplete` is `true`
4. Check the VS Code Output panel for errors

### Completions are slow

- Use a smaller model (`codellama:7b-code` is fastest)
- Reduce `completionMode.maxTokens` (e.g., 256)
- Check system resource usage — `ollama ps` shows model memory consumption

## Agent Mode

### Agent says "task complete" without doing anything

The agent validates file writes for modification tasks. If it hallucinates completion without actually writing files, it gets prompted to retry. If this keeps happening, use a larger/better model.

### Terminal commands hang

The terminal manager requires VS Code Shell Integration (VS Code 1.93+). If a command appears to hang:
- Check that your shell supports VS Code shell integration
- Try running the command manually in a terminal
- The agent session can be stopped with the Stop button

### "Too many sessions are running"

Only a limited number of sessions can generate simultaneously (default: 1). Stop a running session or increase `ollamaCopilot.agent.maxActiveSessions`.

## Session & Data Issues

### Sessions not loading

- Try creating a new chat
- Run "DB Maintenance" from Settings → Advanced to clean up orphaned data
- Check the Output panel for database errors

### Data corruption after crash

If the extension crashed mid-write, LanceDB data may be corrupted. In Settings → Advanced, use "Recreate Messages Table" to rebuild the message store. **This deletes all message content** (session metadata in SQLite is preserved).

### Settings not saving

- Check VS Code settings sync is not overriding local values
- Try reloading the window after saving
- Verify you have write permissions to VS Code's settings directory

## Getting Debug Logs

1. Open the Output panel: **View → Output**
2. Select **"Ollama Copilot"** or **"Ollama Copilot Agent"** from the dropdown
3. Reproduce the issue
4. The log shows API requests, tool calls, and errors
