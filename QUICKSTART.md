# Ollama Copilot - Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Step 1: Install Ollama

```bash
# macOS/Linux
curl -fsSL https://ollama.ai/install.sh | sh

# Or download from https://ollama.ai
```

### Step 2: Pull a Code Model

```bash
# Fast and lightweight (recommended for starters)
ollama pull codellama:7b-code

# High quality (requires more RAM)
ollama pull deepseek-coder:6.7b

# Balanced option
ollama pull qwen2.5-coder:7b
```

### Step 3: Start Ollama

```bash
ollama serve
```

### Step 4: Install the Extension

**Option A: From Source (Current)**
```bash
cd /home/marik/Projects/ollama-copilot
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

**Option B: Install VSIX (After packaging)**
```bash
npm run package
code --install-extension ollama-copilot-0.1.0.vsix
```

### Step 5: Configure

1. Open VS Code Settings (`Cmd/Ctrl + ,`)
2. Search for "Ollama Copilot"
3. Set your model:
   ```json
   {
     "ollamaCopilot.completionMode.model": "codellama:7b-code"
   }
   ```

Or use the quick command:
- Click the robot icon (🤖) in the status bar
- Select your model

### Step 6: Start Coding!

Just start typing code and watch the magic happen! 

- Completions appear as you type (gray ghost text)
- Press `Tab` to accept
- Press `Esc` to dismiss

## 🎯 Current Features

### ✅ Working Now

- **Inline Code Completions** - Works with any FIM-capable model
- **Multi-Model Support** - Switch models on the fly
- **Smart Context** - Uses code before and after cursor
- **OpenWebUI Support** - Connect to remote instances with bearer tokens
- **Language Aware** - Optimized prompts for Python, JavaScript, TypeScript, and more

## ⚙️ Configuration Examples

### Minimal Configuration (Local Ollama)

```json
{
  "ollamaCopilot.baseUrl": "http://localhost:11434",
  "ollamaCopilot.completionMode.model": "codellama:7b-code"
}
```

### Advanced Configuration

```json
{
  "ollamaCopilot.baseUrl": "http://localhost:11434",
  "ollamaCopilot.contextWindow": 16000,
  "ollamaCopilot.completionMode.model": "deepseek-coder:6.7b",
  "ollamaCopilot.completionMode.temperature": 0.1,
  "ollamaCopilot.completionMode.maxTokens": 500,
  "ollamaCopilot.askMode.model": "qwen2.5-coder:7b",
  "ollamaCopilot.askMode.temperature": 0.7,
  "ollamaCopilot.askMode.maxTokens": 2048,
  "ollamaCopilot.agentMode.model": "qwen2.5-coder:14b",
  "ollamaCopilot.agentMode.temperature": 0.4,
  "ollamaCopilot.agentMode.maxTokens": 8192,
  "ollamaCopilot.agent.maxIterations": 25,
  "ollamaCopilot.agent.toolTimeout": 30000
}
```

### OpenWebUI Configuration

```json
{
  "ollamaCopilot.baseUrl": "https://your-openwebui.com",
  "ollamaCopilot.completionMode.model": "codellama:7b-code"
}
```

Then set bearer token:
- Run: `Ollama Copilot: Set Bearer Token`
- Enter your token (stored securely)

## 🔧 Troubleshooting

### No Completions Appearing?

1. **Check Ollama is running**:
   ```bash
   curl http://localhost:11434/api/tags
   ```

2. **Check model is selected**:
   - Look for robot icon (🤖) in status bar
   - Run: `Ollama Copilot: Select Model`

3. **Check Output panel**:
   - View → Output → Select "Ollama Copilot" from dropdown

### Slow Completions?

- Use smaller models: `codellama:7b-code` instead of `deepseek-coder:33b`
- Reduce context: Set `maxTokens` lower (e.g., 256)
- Check CPU/GPU usage in `ollama ps`

### Connection Errors?

- Verify base URL: `http://localhost:11434` (no trailing slash)
- Check firewall settings
- Try: `ollama list` to verify Ollama is working

## 📊 Recommended Models by Use Case

| Use Case | Model | Size | Notes |
|----------|-------|------|-------|
| **Fast Completions** | `codellama:7b-code` | 3.8 GB | Best for inline suggestions |
| **High Quality** | `deepseek-coder:6.7b` | 3.8 GB | More accurate, slightly slower |
| **Balanced** | `qwen2.5-coder:7b` | 4.7 GB | Good quality and speed |
| **Large Projects** | `deepseek-coder:33b` | 20 GB | Best quality, needs powerful hardware |
| **General Coding** | `codellama:13b` | 7.4 GB | Good for chat/questions |

## 🎨 Tips for Best Results

1. **Write comments first** - Describe what you want, then let the model complete
2. **Provide context** - The model sees 2000 chars before and 1000 after cursor
3. **Use descriptive names** - Variable and function names help guide completions
4. **Lower temperature** - 0.1-0.2 for more predictable completions
5. **Language matters** - Works best with Python, JS, TS, Go, Rust, Java

## 🚧 Coming Soon

- **Ask Mode** - Chat with your code
- **Edit Mode** - Natural language code transformations
- **Plan Mode** - Break down complex tasks
- **Agent Mode** - Autonomous multi-file coding

## 🆘 Getting Help

- Check the [README](README.md) for full documentation
- Look at console logs: `Developer: Toggle Developer Tools`
- File issues on GitHub (coming soon)

## 🎉 Quick Start Complete!

You're all set! Start coding and enjoy AI-powered completions running entirely on your local machine.

Press `Tab` to accept suggestions, `Esc` to dismiss. Happy coding! 🚀
