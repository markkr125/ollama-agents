# Ollama Copilot

AI-powered code completion and assistance using local Ollama or OpenWebUI. A free, open-source alternative to GitHub Copilot that runs entirely on your local machine.

## Features

### ✅ Currently Implemented
- **Inline Code Completions** - Real-time code suggestions as you type
- **Multi-Model Support** - Choose from any installed Ollama model
- **FIM (Fill-In-Middle) Support** - Optimized for CodeLlama, DeepSeek Coder, Qwen Coder, StarCoder, and more
- **OpenWebUI Integration** - Supports bearer token authentication for remote instances
- **Model Compatibility Checking** - Warns when using non-code models
- **Configurable Settings** - Per-mode temperature, token limits, and more

### 🚧 In Development
- **Ask Mode** - Interactive chat panel for coding questions
- **Edit Mode** - Natural language code transformations
- **Plan Mode** - Task breakdown and step-by-step execution
- **Agent Mode** - Autonomous multi-file coding with Git integration
- **Session Management** - Track and manage agent sessions
- **Setup Wizard** - User-friendly configuration interface

## Prerequisites

- **VS Code** 1.85.0 or higher
- **Node.js** 20.x or higher
- **Ollama** installed and running (or OpenWebUI instance)
  - Download from: https://ollama.ai
- **Recommended Models**:
  - `codellama:7b-code` (fast completions)
  - `deepseek-coder:6.7b` (high quality)
  - `qwen2.5-coder:7b` (balanced)

## Installation

### From Source

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd ollama-copilot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Compile the extension**
   ```bash
   npm run compile
   ```

4. **Package the extension (optional)**
   ```bash
   npm run package
   ```
   This creates a `.vsix` file you can install manually.

5. **Run in Development Mode**
   - Open the project in VS Code
   - Press `F5` to launch Extension Development Host
   - The extension will be active in the new window

## Configuration

### Basic Setup

1. Open VS Code Settings (`Cmd/Ctrl + ,`)
2. Search for "Ollama Copilot"
3. Configure the following:

   ```json
   {
     "ollamaCopilot.baseUrl": "http://localhost:11434",
     "ollamaCopilot.completionMode.model": "codellama:7b-code",
     "ollamaCopilot.completionMode.temperature": 0.1,
     "ollamaCopilot.completionMode.maxTokens": 500
   }
   ```

### OpenWebUI Setup

If using OpenWebUI proxy:

1. Run command: `Ollama Copilot: Set Bearer Token`
2. Enter your OpenWebUI bearer token
3. Update base URL:
   ```json
   {
     "ollamaCopilot.baseUrl": "https://your-openwebui-instance.com"
   }
   ```

### Model Selection

1. Click the robot icon (🤖) in the status bar, OR
2. Run command: `Ollama Copilot: Select Model`
3. Choose from your installed models

## Usage

### Inline Completions

1. Install a code model: `ollama pull codellama:7b-code`
2. Select the model in VS Code
3. Start typing - suggestions appear automatically
4. Press `Tab` to accept, `Esc` to dismiss

### Tips for Best Results

- **Use FIM-capable models** for better completions
- **Lower temperature** (0.1-0.3) for more deterministic completions
- **Provide context** - the model sees code before and after your cursor
- **Language-specific** - works best with mainstream languages

## Project Structure

```
ollama-copilot/
├── src/
│   ├── extension.ts              # Main entry point
│   ├── types/                    # TypeScript interfaces
│   │   ├── ollama.ts            # Ollama API types
│   │   ├── session.ts           # Agent session types
│   │   └── config.ts            # Configuration types
│   ├── services/                 # Core services
│   │   ├── ollamaClient.ts      # Ollama/OpenWebUI API client
│   │   ├── tokenManager.ts      # Secure token storage
│   │   ├── modelManager.ts      # Model selection & caching
│   │   ├── modelCompatibility.ts # Model capability checking
│   │   ├── contextBuilder.ts    # Code context extraction
│   │   └── historyManager.ts    # Conversation history
│   ├── providers/                # VS Code providers
│   │   └── completionProvider.ts # Inline completion provider
│   ├── templates/                # Prompt templates
│   │   └── fimTemplates.ts      # FIM format templates
│   ├── utils/                    # Utilities
│   │   ├── streamParser.ts      # NDJSON stream parser
│   │   ├── tokenCounter.ts      # Token estimation
│   │   └── debounce.ts          # Debouncing utility
│   ├── modes/                    # (To be implemented)
│   │   ├── askMode.ts           # Chat participant
│   │   ├── editMode.ts          # Code editing
│   │   ├── planMode.ts          # Task planning
│   │   └── agentMode.ts         # Autonomous agent
│   ├── agent/                    # (To be implemented)
│   │   ├── toolRegistry.ts      # Tool definitions
│   │   ├── executor.ts          # Agent execution loop
│   │   ├── sessionManager.ts    # Session tracking
│   │   ├── sessionViewer.ts     # Tree view provider
│   │   ├── gitOperations.ts     # Git integration
│   │   └── prWorkflow.ts        # PR creation
│   ├── webview/                  # (To be implemented)
│   │   ├── setupWizard.ts       # Setup wizard logic
│   │   └── setupWizard.html     # Setup wizard UI
│   └── config/
│       └── settings.ts           # Settings management
├── package.json                  # Extension manifest
├── tsconfig.json                 # TypeScript configuration
├── webpack.config.js             # Webpack bundling config
└── README.md                     # This file
```

## Development Roadmap

### Phase 1: Core Features ✅
- [x] Ollama client with streaming
- [x] Bearer token support
- [x] Inline completions
- [x] FIM template system
- [x] Model management
- [x] Basic configuration

### Phase 2: Chat & Edit (Next)
- [ ] Ask mode chat participant
- [ ] Slash commands (/explain, /fix, /generate)
- [ ] Edit mode with diff preview
- [ ] Multi-format diff parsing
- [ ] Context references (#file, #selection)

### Phase 3: Planning & Agent
- [ ] Plan mode task breakdown
- [ ] Task tracking with persistence
- [ ] Agent mode with tool registry
- [ ] File operations (read/write)
- [ ] Terminal command execution
- [ ] Git operations with CLI fallback

### Phase 4: Polish
- [ ] Setup wizard webview
- [ ] Session viewer tree
- [ ] Output channel logging
- [ ] PR workflow integration
- [ ] Performance optimizations
- [ ] Comprehensive testing

## Contributing

This is a personal project, but contributions are welcome! Areas that need work:

1. **Mode Implementations** - Ask, Edit, Plan, and Agent modes
2. **Tool System** - Define and implement agent tools
3. **UI/UX** - Setup wizard, session viewer, progress indicators
4. **Testing** - Unit tests, integration tests
5. **Documentation** - API docs, user guides, examples

## Troubleshooting

### "Cannot connect to Ollama"
- Ensure Ollama is running: `ollama serve`
- Check the base URL in settings
- Try: `curl http://localhost:11434/api/tags`

### "Model not found"
- Pull the model: `ollama pull codellama:7b-code`
- Refresh model list with `Ollama Copilot: Select Model`

### "No completions appearing"
- Check that a model is selected (status bar icon)
- Verify model supports FIM (CodeLlama, DeepSeek Coder, etc.)
- Check VS Code Output panel for errors

### "Invalid bearer token"
- Re-enter token with `Ollama Copilot: Set Bearer Token`
- Verify token is valid in OpenWebUI settings

## License

MIT License - See LICENSE file for details

## Acknowledgments

- Built with [Ollama](https://ollama.ai)
- Inspired by GitHub Copilot
- Uses VS Code Extension API
- FIM template patterns from various code models

## Support

- **Issues**: https://github.com/your-username/ollama-copilot/issues
- **Discussions**: https://github.com/your-username/ollama-copilot/discussions

---

**Note**: This is an early-stage project. Features are being actively developed. Expect breaking changes and incomplete functionality.
