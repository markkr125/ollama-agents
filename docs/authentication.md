# Authentication

## Table of Contents

- [When You Need a Token](#when-you-need-a-token)
- [Setting the Bearer Token](#setting-the-bearer-token)
- [Getting a Token from OpenWebUI](#getting-a-token-from-openwebui)
- [Managing Your Token](#managing-your-token)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

---

## When You Need a Token

A bearer token is only needed when connecting to **OpenWebUI** (or another authenticated proxy). If you're using local Ollama directly (`http://localhost:11434`), no token is required.

## Setting the Bearer Token

### Command Palette (recommended)

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type: **Ollama Copilot: Set Bearer Token**
3. Enter your OpenWebUI API key
4. The token is stored securely in VS Code's encrypted secret storage

### From the Settings Page

1. Open the Ollama Copilot sidebar (robot icon in Activity Bar)
2. Click the gear icon to open Settings
3. The **Connection** section has a bearer token field

## Getting a Token from OpenWebUI

1. Log into your OpenWebUI instance
2. Go to **Settings → Account → API Keys**
3. Create a new API key or copy an existing one
4. Use this key as your bearer token in VS Code

## Managing Your Token

Run `Ollama Copilot: Set Bearer Token` again to:

- **Update** — enter a new token
- **Remove** — select the "Remove Token" option
- **Cancel** — keep the existing token

The `bearerTokenConfigured` setting (read-only) shows whether a token is currently stored.

## Security

- Token is stored in VS Code's **encrypted secret storage** (system keychain)
- Never stored in plain text settings files
- Never synced to Git repositories
- Only accessible to the Ollama Copilot extension

## Troubleshooting

### "Invalid bearer token" error

- Verify the token is correct in OpenWebUI → Settings → API Keys
- Try removing and re-entering the token
- Confirm your OpenWebUI instance is accessible from your machine

### Token not persisting

- Ensure VS Code has permission to use the system keychain
- Check that VS Code is not running in restricted mode

### Using local Ollama (no token needed)

- Leave the token empty
- Set `baseUrl` to `http://localhost:11434`
- No authentication is required for local Ollama
