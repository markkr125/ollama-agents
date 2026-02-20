# Chat & Modes

## Table of Contents

- [Opening the Chat](#opening-the-chat)
- [Agent Mode](#agent-mode)
- [Plan Mode](#plan-mode)
- [Chat Mode](#chat-mode)
- [Slash Commands](#slash-commands)
- [Sub-Agent (Internal)](#sub-agent-internal)
- [Thinking Blocks](#thinking-blocks)
- [Inline Completions](#inline-completions)
- [Session Management](#session-management)
- [Command Approval](#command-approval)
- [File Edit Approval](#file-edit-approval)
- [Files Changed Widget](#files-changed-widget)
- [Inline Change Review](#inline-change-review)

---

## Opening the Chat

Click the **Ollama Copilot** icon (robot) in the Activity Bar to open the sidebar chat. The chat interface has:

- **Mode selector** — switch between Agent, Plan, and Chat
- **Model selector** — choose which model to use (only enabled models appear; shows "No enabled models" if all are disabled)
- **Context button** — attach code from the active editor
- **Sessions panel** — view, search, and manage conversation history

## Agent Mode

The autonomous coding agent. It can read/write files, search your workspace, and run terminal commands to complete tasks.

**How it works:**
1. You describe a task ("Add error handling to the login function")
2. The **agent dispatcher** classifies your intent (analysis, modification, creation, or mixed) — this happens automatically via a fast LLM call before the agent starts working
3. Pure analysis tasks (explain, trace, document) are routed to a read-only executor; tasks that require code changes use the full agent executor
4. The system prompt is framed based on your intent — e.g., analysis tasks get explicit "do NOT modify source code" guidance
5. The agent executes tools (read files, write files, run commands) in a loop
6. Each tool action is shown in collapsible progress groups
7. Terminal commands and sensitive file edits require your approval
8. The agent completes when it signals `[TASK_COMPLETE]`

**Tool calling modes:**
- **Native** — If the model supports function calling (shown in the Tools column of Model Capabilities), the extension uses Ollama's native `tools` API with structured `tool_calls` responses. This is the most reliable path. The conversation history uses `{role: 'tool', content, tool_name}` so the model can match results to the originating call.
- **XML fallback** — If the model does not support native tool calling, the agent falls back to XML-based tool parsing (`<tool_call>` tags). Tool results are bundled into a single user message instead of individual tool messages. A warning banner is shown at the top of the chat to indicate degraded functionality.

**Thinking support:** Thinking models (Qwen 3, GPT-OSS, DeepSeek R1, etc.) reason automatically — Ollama enables thinking by default for supported models. The model's reasoning trace is displayed in a collapsible block in the UI but is **not** included in conversation history (per Ollama best practices). The model thinks fresh each iteration.

**Available tools:**
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write/modify files |
| `create_file` | Create new files |
| `list_files` | List directory contents |
| `search_workspace` | Search for text or regex patterns in files (supports case-insensitive matching, alternatives, wildcards via `isRegex` flag; optional `directory` param to scope to a folder) |
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
| `run_subagent` | Launch an independent read-only sub-agent for complex investigation tasks |

> **Code intelligence tools** (last 8 above) use VS Code's Language Server Protocol — they work for any language with an active LSP extension (TypeScript, Python, Java, Rust, etc.).

**Auto-approve:** You can toggle auto-approve per session for terminal commands and sensitive file edits. Critical commands (`rm -rf`, `sudo`, etc.) always require manual approval regardless of the toggle.

**Tool result display:**
- **File edits**: When complete, shown as a flat list with filename, verb (Created/Edited), and `+N -N` diff stats. Clicking a filename opens the diff view.
- **Search results**: Shown as a collapsible group listing matched files with match counts. Clicking a filename opens it in the editor.
- **Directory listings**: Shown as a tree with folder/file icons. Clicking entries opens files or reveals folders in the explorer.
- **Terminal commands**: Show the command, exit code, and truncated output.

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
4. A **"Start Implementation"** button appears at the bottom of the plan
5. Clicking it switches to Agent mode and sends the plan as the prompt

Uses a read-only tool set (same tools as Agent mode except no `write_file`, `run_terminal_command`, or `run_subagent`).

## Chat Mode

General Q&A about code with access to read-only tools. Chat mode routes through the exploration engine, giving the model access to all 12 read-only code intelligence tools (same as Plan mode) so it can look up definitions, search the codebase, and check types to give accurate answers.

- Good for: explaining code, answering questions with tool-verified accuracy, quick code lookups
- Uses the `chatMode.model` and temperature settings
- Conversation history is maintained per session
- Read-only: cannot create, modify, or delete files
- Replaces the former Ask and Edit modes

## Slash Commands

Special commands that can be typed in any mode:

| Command | Description |
|---------|-------------|
| `/review` | Run a security and quality code review using the read-only review agent |
| `/review <instructions>` | Review with specific focus (e.g., `/review check for SQL injection`) |
| `/security-review` | Alias for `/review` with a security-focused prompt |
| `/deep-explore` | Deep recursive code exploration — traces every function call to its source using a 4-phase methodology (Map → Trace depth-first → Cross-cutting analysis → Synthesize) |
| `/deep-explore <instructions>` | Deep explore with specific focus (e.g., `/deep-explore trace all auth handlers`) |

The `/review` command internally uses the explore executor in review mode. It has access to all read-only code intelligence tools plus limited git commands (`git log`, `git diff`, `git show`). Output includes severity ratings, affected files, and remediation steps.

## Sub-Agent (Internal)

The `run_subagent` tool allows the main Agent to spawn a read-only sub-agent for complex multi-step investigation tasks. This is not a user-facing mode — it's a tool the agent can call autonomously.

**How it works:**
1. The agent identifies a research task that requires multiple tool calls
2. It calls `run_subagent` with a task description and mode (`explore`, `review`, or `deep-explore`)
3. A lightweight explore/review/deep-explore executor runs the sub-task in **isolated mode**
4. The sub-agent's findings are returned as text to the main agent — they are **not** shown to the user automatically
5. The parent agent must act on the findings itself (e.g., write files, make edits)

**Isolation:** The sub-agent runs with a filtered emitter that only passes tool UI events (progress groups, tool actions) to the chat. Streaming text, thinking blocks, token usage, and the final message are all suppressed to prevent interference with the parent agent's timeline. The user sees the sub-agent's tool activity (so they know work is happening) but not its raw output.

**Key constraints:**
- Sub-agents are **strictly read-only** — they cannot write files, create files, or run terminal commands
- Sub-agent output goes **only to the parent agent**, not to the user
- The parent agent is responsible for acting on findings (writing code, making edits, etc.)

**Use cases:**
- Researching code patterns across a large codebase
- Investigating a specific subsystem before making changes
- Running a security review of a component mid-task
- Deep exploration of a module's call hierarchy before documenting it

## Thinking Blocks

Thinking models (Qwen 3, GPT-OSS, DeepSeek R1, etc.) automatically produce a reasoning trace alongside their response — Ollama enables thinking by default for supported models. The extension does not send an explicit `think` parameter; it relies on the model's default behavior.

**During live chat:**
- Thinking tokens stream in real time inside a collapsible `<details>` element labeled "Thought"
- The block starts open so you can watch the reasoning unfold
- When the model begins using tools, the thinking block collapses with an accurate duration ("Thought for 8s")
- At the end of generation, the last thinking group stays **open** so tool results remain visible and clickable

**In session history:**
- Thinking blocks are persisted as `thinkingBlock` UI events
- When a session is reloaded, thinking blocks appear collapsed (since the reasoning is already complete)
- Multiple thinking rounds within one response create separate collapsible blocks

Thinking blocks appear in both Agent mode (between tool execution rounds) and Chat mode (before the response).

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
