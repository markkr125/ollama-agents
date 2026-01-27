# Setting Bearer Token for OpenWebUI

The bearer token is stored securely in VS Code's encrypted secret storage, not in plain text settings files.

## How to Set Bearer Token

### Option 1: Command Palette (Recommended)

1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type: `Ollama Copilot: Set Bearer Token`
3. Press Enter
4. Enter your OpenWebUI bearer token
5. The token will be stored securely

### Option 2: Click in Settings

1. Open VS Code Settings (`Cmd/Ctrl + ,`)
2. Search for "Ollama Copilot"
3. Look for the "Bearer Token Configured" setting
4. Click on the deprecation message or description
5. Or scroll up and click the "Set Bearer Token" link in the Base URL description

### Option 3: Status Bar

The command is also available through the VS Code command palette at any time.

## Verifying Token is Set

After setting your token, you'll see:
- ✅ The setting `Bearer Token Configured` will show as `true`
- ✅ Connection test will succeed if the token is valid
- ❌ You'll get an authentication error if the token is invalid

## Managing Your Token

Run `Ollama Copilot: Set Bearer Token` again to:
- **Update Token** - Enter a new token
- **Remove Token** - Select "Remove Token" option
- **Cancel** - Keep existing token

## Getting Your Bearer Token from OpenWebUI

1. Log into your OpenWebUI instance
2. Go to Settings → Account → API Keys
3. Create a new API key or copy existing one
4. Use this as your bearer token in VS Code

## Security

- ✅ Token is stored in VS Code's secure storage (encrypted)
- ✅ Never stored in plain text settings files
- ✅ Never synced to GitHub or Git repositories
- ✅ Only accessible to the Ollama Copilot extension

## Troubleshooting

### "Invalid bearer token" error
- Verify token is correct in OpenWebUI
- Try removing and re-entering the token
- Check that your OpenWebUI instance is accessible

### Token not persisting
- Make sure VS Code has permission to use system keychain
- Check VS Code is not running in restricted mode

### Using local Ollama (no token needed)
- Leave the token empty
- Just ensure `baseUrl` is set to `http://localhost:11434`
- No authentication required for local Ollama
