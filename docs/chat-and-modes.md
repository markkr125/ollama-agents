# Chat & Modes

## Table of Contents

- [Opening the Chat](#opening-the-chat)
- [Agent Mode](#agent-mode)
- [Explore Mode](#explore-mode)
- [Plan Mode](#plan-mode)
- [Review Mode](#review-mode)
- [Thinking Blocks](#thinking-blocks)
- [Chat Mode (Ask)](#chat-mode-ask)
- [Edit Mode](#edit-mode)
- [Inline Completions](#inline-completions)
- [Session Management](#session-management)
- [Command Approval](#command-approval)
- [File Edit Approval](#file-edit-approval)
- [Files Changed Widget](#files-changed-widget)
- [Inline Change Review](#inline-change-review)

---

## Opening the Chat

Click the **Ollama Copilot** icon (robot) in the Activity Bar to open the sidebar chat. The chat interface has:

- **Mode selector** — switch between Agent, Explore, Plan, Review, Ask, and Edit
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
| `search_workspace` | Search for text or regex patterns in files (supports case-insensitive matching, alternatives, wildcards via `isRegex` flag) |
| `run_terminal_command` | Execute shell commands |
| `get_diagnostics` | Get TypeScript/ESLint errors for a file |
| `get_document_symbols` | Get a file's outline — classes, functions, variables with line ranges |
| `find_definition` | Go to definition of a symbol (follows function calls across files) |
| `find_references` | Find all usages of a symbol across the workspace |
| `find_symbol` | Search for a class/function by name across the workspace |
| `get_hover_info` | Get type signature and documentation for a symbol |
| `get_call_hierarchy` | Trace incoming and/or outgoing call chains |
| `find_implementations` | Find concrete implementations of an interface or abstract class |
| `get_type_hierarchy` | Show inheritance chains — supertypes and subtypes |

> **Code intelligence tools** (last 8 above) use VS Code's Language Server Protocol — they work for any language with an active LSP extension (TypeScript, Python, Java, Rust, etc.).

**Auto-approve:** You can toggle auto-approve per session for terminal commands and sensitive file edits. Critical commands (`rm -rf`, `sudo`, etc.) always require manual approval regardless of the toggle.

**Tool result display:**
- **File edits**: When complete, shown as a flat list with filename, verb (Created/Edited), and `+N -N` diff stats. Clicking a filename opens the diff view.
- **Search results**: Shown as a collapsible group listing matched files with match counts. Clicking a filename opens it in the editor.
- **Directory listings**: Shown as a tree with folder/file icons. Clicking entries opens files or reveals folders in the explorer.
- **Terminal commands**: Show the command, exit code, and truncated output.

## Explore Mode

Read-only codebase exploration. The agent uses all code intelligence tools (LSP-powered definition, references, symbols, call hierarchy, etc.) without modifying any files.

**Best for:**
- Understanding unfamiliar codebases
- Tracing call chains and data flow
- Finding where something is defined or used
- Getting an overview of project structure

**Differences from Agent mode:**
- No `write_file` or `run_terminal_command` tools available
- No approval flow needed (purely read-only)
- Lower iteration cap (10 vs 25)
- Parallel search and exploration strategy

## Plan Mode

Tool-powered implementation planning. The agent explores the codebase using read-only tools to build a detailed, multi-step implementation plan.

**Best for:**
- Planning a feature before writing code
- Understanding what files need to change
- Breaking down complex tasks into steps

**How it works:**
1. You describe what you want to implement
2. The agent explores relevant files, types, and patterns
3. It produces a structured plan with:
   - File-by-file changes needed
   - Dependencies and ordering
   - Potential risks or gotchas

Uses the same read-only tool set as Explore mode.

## Review Mode

Security and quality review. The agent reviews code for vulnerabilities, anti-patterns, and quality issues.

**Best for:**
- Security audits (injection, XSS, auth bypass, path traversal)
- Code quality review before merging
- Finding anti-patterns and tech debt

**Differences from Explore mode:**
- Security-focused system prompt
- Additionally allows `run_terminal_command` for git read commands (`git log`, `git diff`, `git show`)
- Structured output: severity ratings, affected files, remediation steps

## Thinking Blocks

When `ollamaCopilot.agent.enableThinking` is enabled (default: `true`), the extension passes `think: true` to the Ollama API. Models that support chain-of-thought reasoning will return their internal reasoning alongside the normal response.

**During live chat:**
- Thinking tokens stream in real time inside a collapsible `<details>` element labeled "Thought"
- The block starts open so you can watch the reasoning unfold
- When the model begins using tools, the thinking block collapses with an accurate duration ("Thought for 8s")
- At the end of generation, the last thinking group stays **open** so tool results remain visible and clickable

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

## Files Changed Widget

After the agent modifies files, a **Files Changed** widget appears at the bottom of the chat. It shows all files the agent wrote or created, grouped across agent iterations.

**Widget features:**
- **Per-file rows**: Each file shows its relative path, `+N -N` diff stats (additions/deletions), and action buttons
- **Keep / Undo per file**: Click ✓ to accept a file's changes permanently, or ↩ to revert to the original content
- **Keep All / Undo All**: Bulk actions in the header to accept or revert all changes at once
- **Diff view**: Click the diff icon on a file row to open VS Code's native side-by-side diff editor
- **Inline review**: Click the review icon to open the file with inline decorations and CodeLens (see [Inline Change Review](#inline-change-review))
- **Change navigation**: A nav bar shows "Change X of Y" with ◀ / ▶ buttons to step through individual hunks (changed regions) across all files. The currently navigated file is highlighted with a blue left border.
- **Session stats badge**: The sessions panel shows `+N -N` badges reflecting the total pending additions/deletions for each session. These update in real time as you keep or undo files.

**Multi-iteration support:** When the agent runs multiple tool iterations (each generating changes), all files accumulate into a single widget. Navigation covers all hunks across all iterations in chronological order.

## Inline Change Review

Inline change review provides a GitHub-style code review experience directly in the editor:

**How it works:**
1. After the agent finishes, green (added) and red (deleted) line decorations automatically appear on any open files that were modified
2. Each changed region ("hunk") has CodeLens actions above it:
   - **Keep** (✓) — Accept the change and remove the decoration
   - **Undo** (↩) — Revert the hunk to the original text
   - **↑ / ↓** — Navigate to the previous/next hunk (works across files)
3. After all hunks in a file are resolved (kept or undone), the file is automatically marked as resolved in the widget

**Cross-file navigation:** The ↑ / ↓ CodeLens buttons and the widget's ◀ / ▶ nav buttons both navigate through ALL hunks across ALL modified files in chronological order. When navigating to a hunk in a different file, the editor automatically opens and scrolls to that file.
