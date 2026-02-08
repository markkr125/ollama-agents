# Chat & Modes

## Table of Contents

- [Opening the Chat](#opening-the-chat)
- [Agent Mode](#agent-mode)
- [Thinking Blocks](#thinking-blocks)
- [Chat Mode (Ask)](#chat-mode-ask)
- [Edit Mode](#edit-mode)
- [Inline Completions](#inline-completions)
- [Session Management](#session-management)
- [Command Approval](#command-approval)
- [File Edit Approval](#file-edit-approval)

---

## Opening the Chat

Click the **Ollama Copilot** icon (robot) in the Activity Bar to open the sidebar chat. The chat interface has:

- **Mode selector** — switch between Agent, Ask, and Edit
- **Model selector** — choose which model to use (only enabled models appear; shows "No enabled models" if all are disabled)
- **Context button** — attach code from the active editor
- **Sessions panel** — view, search, and manage conversation history

## Agent Mode

The autonomous coding agent. It can read/write files, search your workspace, and run terminal commands to complete tasks.

**How it works:**
1. You describe a task ("Add error handling to the login function")
2. The agent analyzes the request and plans its approach
3. It executes tools (read files, write files, run commands) in a loop
4. Each tool action is shown in collapsible progress groups
5. Terminal commands and sensitive file edits require your approval
6. The agent completes when it signals `[TASK_COMPLETE]`

**Tool calling modes:**
- **Native** — If the model supports function calling (shown in the Tools column of Model Capabilities), the extension uses Ollama's native `tools` API with structured `tool_calls` responses. This is the most reliable path. The conversation history uses `{role: 'tool', content, tool_name}` so the model can match results to the originating call.
- **XML fallback** — If the model does not support native tool calling, the agent falls back to XML-based tool parsing (`<tool_call>` tags). Tool results are bundled into a single user message instead of individual tool messages. A warning banner is shown at the top of the chat to indicate degraded functionality.

**Thinking support:** When `ollamaCopilot.agent.enableThinking` is enabled, the extension passes `think: true` to the API. The model's internal reasoning (`thinking` field) is preserved in conversation history across iterations so the model maintains its chain-of-thought context.

**Available tools:**
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write/modify files |
| `create_file` | Create new files |
| `list_files` | List directory contents |
| `search_workspace` | Search for text in files |
| `run_terminal_command` | Execute shell commands |
| `get_diagnostics` | Get TypeScript/ESLint errors for a file |

**Auto-approve:** You can toggle auto-approve per session for terminal commands and sensitive file edits. Critical commands (`rm -rf`, `sudo`, etc.) always require manual approval regardless of the toggle.

## Thinking Blocks

When `ollamaCopilot.agent.enableThinking` is enabled (default: `true`), the extension passes `think: true` to the Ollama API. Models that support chain-of-thought reasoning will return their internal reasoning alongside the normal response.

**During live chat:**
- Thinking tokens stream in real time inside a collapsible `<details>` element labeled "Thought"
- The block starts open so you can watch the reasoning unfold
- Once thinking is complete, the block collapses automatically

**In session history:**
- Thinking blocks are persisted as `thinkingBlock` UI events
- When a session is reloaded, thinking blocks appear collapsed (since the reasoning is already complete)
- Multiple thinking rounds within one response create separate collapsible blocks

Thinking blocks appear in both Agent mode (between tool execution rounds) and Ask/Edit modes (before the response).

## Chat Mode (Ask)

General Q&A about code. The model responds in a single turn without using tools.

- Good for: explaining code, answering questions, brainstorming
- Uses the `askMode.model` and temperature settings
- Conversation history is maintained per session

## Edit Mode

Similar to chat mode but with a system prompt optimized for code modifications. Select code in the editor, attach it as context, and describe the edit you want.

## Inline Completions

Real-time code suggestions as you type (ghost text). Requires a FIM-capable model.

- Press **Tab** to accept a suggestion
- Press **Esc** to dismiss
- Controlled by the `completionMode.*` settings
- Enable/disable with `ollamaCopilot.enableAutoComplete`

## Session Management

Every conversation is saved as a session.

**Sessions panel features:**
- Click a session to load it
- Search sessions by content (hybrid text + semantic search)
- Delete individual sessions (swipe or click delete)
- Multi-select and batch delete
- Sessions show relative timestamps ("2h ago", "Yesterday")
- Pagination for large session lists

**Session reuse:** Clicking "New Chat" when there's already an empty idle session reuses it instead of creating a duplicate.

## Command Approval

When the agent wants to run a terminal command, it shows an approval card with:

- The command to run
- The working directory
- A severity indicator (medium / high / critical)
- An **editable command input** — you can modify the command before approving

After approval, the command runs in a VS Code integrated terminal and the output is shown to the agent.

**Severity levels:**
| Level | Examples | Auto-approve |
|-------|----------|--------------|
| Critical | `rm -rf /`, `mkfs`, `dd` | Never — always requires manual approval |
| High | `sudo`, `chmod 777`, `npm publish` | Only if auto-approve is on |
| Medium | `npm install`, `docker run` | Only if auto-approve is on |
| None | `ls`, `cat`, `echo` | Yes if auto-approve is on |

## File Edit Approval

When the agent edits a file matching a sensitive pattern, it shows:

- The file path
- A side-by-side diff of the changes
- Approve / Reject buttons
- An "Open Diff" button to view in VS Code's native diff editor

Sensitivity is controlled by `ollamaCopilot.agent.sensitiveFilePatterns`. See [Configuration](configuration.md#sensitive-file-patterns).
