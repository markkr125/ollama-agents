---
applyTo: "src/agent/**,src/services/agentChatExecutor.ts,src/utils/toolCallParser.ts"
description: "Agent execution flow, tool registry, tool call parser robustness, terminal execution, command safety, file sensitivity, and approval flow"
---

# Agent Tools & Execution

## Agent Execution Flow

When user sends a message in Agent mode:

```
1. handleAgentMode()
   ├─ Create agent session
   ├─ Create git branch (if enabled)
   └─ agentChatExecutor.execute()   ← AgentChatExecutor.execute() method
       ├─ Detect tool calling mode:
       │   ├─ Native: model has 'tools' capability → uses Ollama tools API
       │   └─ XML fallback: no capability → parses <tool_call> from text
       ├─ Create checkpoint (SQLite) → currentCheckpointId
       └─ LOOP (max iterations):
           ├─ Build chat request (with tools[] + think:true if native)
           ├─ Stream LLM response via OllamaClient.chat()
           │   ├─ Accumulate thinking tokens (chunk.message.thinking)
           │   ├─ Accumulate native tool_calls (chunk.message.tool_calls)
           │   ├─ Accumulate text content (chunk.message.content)
           │   └─ Throttled streamChunk to UI (32ms, first-chunk gate ≥8 word chars)
           ├─ Persist thinking block (if any)
           ├─ Extract tool calls (native tool_calls[] OR XML <tool_call> parsing)
           ├─ If tools found:
           │   ├─ Push assistant message to history (with thinking + tool_calls)
           │   ├─ Persist + post 'startProgressGroup'
           │   ├─ For each tool:
           │   │   ├─ [write_file] → snapshotFileBeforeEdit() → fileSensitivity → approval
           │   │   ├─ [Terminal cmd] → commandSafety → approval flow
           │   │   ├─ [Other tool] → direct execution via ToolRegistry
           │   │   ├─ Persist tool result to DB
           │   │   ├─ Persist + post 'showToolAction' (success/error)
           │   │   └─ Feed result back: {role:'tool', content, tool_name} (native)
           │   │                     or accumulated user message (XML)
           │   └─ Persist + post 'finishProgressGroup'
           ├─ If [TASK_COMPLETE] → validate writes → break loop
           └─ Continue to next iteration
       → Persist final assistant message to DB
       → Post 'finalMessage' to webview
       → Persist + post 'filesChanged' with checkpointId (if files modified)
       → Return { summary, assistantMessage, checkpointId }
   ← Back in handleAgentMode():
       → reviewService.startReviewForCheckpoint(checkpointId)
         (decorates already-open editors with green/red + CodeLens)
       → Post 'generationStopped'
```

## Native Tool Calling vs XML Fallback

The executor supports two tool calling paths, selected based on model capabilities:

| Path | When Used | Request | Response | History Format |
|------|-----------|---------|----------|----------------|
| **Native** | Model has `tools` capability | `chatRequest.tools = [ToolDefinition...]` | `chunk.message.tool_calls: [{function:{name, arguments}}]` | `{role:'tool', content, tool_name}` per tool |
| **XML fallback** | Model lacks `tools` capability | Tool descriptions in system prompt | `<tool_call>{"name":"...", "arguments":{...}}</tool_call>` in text | Accumulated `{role:'user', content}` message |

**Native tool calling conversation structure** (matches [Ollama docs](https://docs.ollama.com/capabilities/tool-calling)):
```
[system] You are a coding agent...
[user] Create a hello world file
[assistant, thinking: "...", tool_calls: [{function:{name:"write_file", arguments:{...}}}]]
[tool, tool_name: "write_file"] File written successfully
[assistant, thinking: "..."] Done! [TASK_COMPLETE]
```

**Key rules:**
- Assistant messages MUST include `thinking`, `content`, AND `tool_calls` — omitting `thinking` causes the model to lose chain-of-thought context across iterations
- Tool result messages MUST include `tool_name` — without it, the model can't match results to calls in multi-tool responses
- Do NOT deduplicate tool calls — Ollama sends each as a complete object in its own chunk; dedup would drop legitimate repeated calls
- `ToolCall` type has optional `id`, `type`, and `function.index` fields — Ollama returns `type: 'function'` and `function.index` but NOT `id`

## ToolRegistry (`src/agent/toolRegistry.ts`)

Defines tools available to the agent for autonomous operations.

**Built-in Tools (6 total — defined in `registerBuiltInTools()`):**
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write/create file (handles both) |
| `list_files` | List directory contents |
| `search_workspace` | Search for text in files |
| `run_terminal_command` | Execute shell commands |
| `get_diagnostics` | Get file errors/warnings |

**Tool Call Format (in LLM responses):**
```xml
<tool_call>{"name": "read_file", "arguments": {"path": "src/file.ts"}}</tool_call>
```

## Tool Call Parser (`src/utils/toolCallParser.ts`)

Parses tool calls from LLM responses. This is critical for agent functionality and must handle various LLM output quirks robustly.

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `extractToolCalls(response)` | Parse all tool calls from response text |
| `detectPartialToolCall(response)` | Detect in-progress tool call during streaming |
| `removeToolCalls(response)` | Strip tool call markup for display |

### Robustness Features

The parser handles various LLM quirks that smaller models (like devstral-small) may produce:

1. **Balanced JSON Extraction** - Uses brace counting instead of regex to properly extract nested JSON:
   ```typescript
   // WRONG: /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/  (stops at first })
   // RIGHT: extractBalancedJson() counts { and } to find matching close
   ```

2. **Multiple Argument Field Names** - Accepts `arguments`, `args`, `params`, or `parameters`:
   ```json
   {"name": "read_file", "args": {"path": "file.ts"}}  // works
   {"name": "read_file", "arguments": {"path": "file.ts"}}  // works
   ```

3. **Top-Level Arguments** - Accepts args at root level instead of nested:
   ```json
   {"name": "read_file", "path": "file.ts"}  // works (path extracted from top level)
   ```

4. **Multiple Tool Name Fields** - Accepts `name`, `tool`, or `function`:
   ```json
   {"tool": "read_file", "arguments": {"path": "file.ts"}}  // works
   ```

5. **Incomplete Tool Calls** - Handles LLM getting cut off mid-response:
   ```xml
   <tool_call>{"name": "write_file", "arguments": {"path": "x.ts", "content": "...
   ```
   The parser attempts to repair by adding missing closing braces.

### Tool Argument Flexibility

Tools in `toolRegistry.ts` also accept multiple argument names for the file path:
- `path`, `file`, or `filePath` are all valid for `read_file`, `write_file`, `get_diagnostics`

## Streaming Behavior

### First-Chunk Gate
The executor uses a 32ms throttle for streaming text to the UI. The **first chunk** requires ≥8 word characters before the spinner is replaced with text. This prevents partial markdown fragments like `**What` from flashing on screen. After the first chunk, any content with ≥1 word character is shown.

### `[TASK_COMPLETE]` Stripping
The control signal `[TASK_COMPLETE]` is stripped from all displayed content:
- Full match: regex `/\[TASK_COMPLETE\]/gi`
- Partial prefix: a reverse scan strips any trailing prefix of `[TASK_COMPLETE]` (e.g. `[TASK`, `[TAS`) since tokens arrive incrementally
- Applied to: streamed text, thinking content, and persisted thinking blocks

### Terminal Command CWD Resolution
`executeTerminalCommand()` resolves the `cwd` argument relative to the workspace root. Absolute paths that fall outside the workspace are clamped to the workspace root. If no `cwd` is provided, commands run in the workspace root.

### Write Validation

The agent executor tracks whether a task requires file writes (based on keywords like "rename", "modify", "create", etc.) and validates that `write_file` was actually called before accepting `[TASK_COMPLETE]`. This prevents the LLM from hallucinating task completion.

## Terminal Command Execution

### Shell Integration Requirement
Terminal commands execute via `TerminalManager` (`src/services/terminalManager.ts`), which **requires VS Code Terminal Shell Integration** (VS Code 1.93+). The manager waits up to 5 seconds for shell integration to appear; if unavailable, it throws a hard error.

### Session-Keyed Terminals
Terminals are **keyed by session ID** — one terminal per agent session, reused across all commands in that session. Terminals are auto-cleaned when VS Code closes them.

### Output Handling
- Output is truncated to **100 lines** (15 head + 85 tail) with a `[N lines truncated]` marker
- ANSI escape sequences and VS Code `]633;` shell integration markers are stripped
- **Caveat**: `waitForCommandEnd()` relies on the `onDidEndTerminalShellExecution` event. If the event never fires (shell integration bug), the promise never resolves — there is no timeout

## Command Safety & Approval Flow

### Severity Tiers (`src/utils/commandSafety.ts`)
`analyzeDangerousCommand()` returns a severity from highest-match in a static regex pattern array:

| Severity | Examples | Behavior |
|----------|----------|----------|
| `critical` | `rm -rf /`, fork bombs, `mkfs`, `dd if=` | **Always requires approval** — ignores auto-approve |
| `high` | `sudo`, `chmod 777`, `kill -9`, `npm publish` | Requires approval unless auto-approved |
| `medium` | `npm install`, `pip install`, `docker run` | Requires approval unless auto-approved |
| `none` | `ls`, `cat`, `echo` | Auto-approved if toggle enabled |

### Approval Decision (`src/utils/terminalApproval.ts`)
`computeTerminalApprovalDecision()` returns the final decision:
1. **Critical severity** → always requires approval (regardless of `auto_approve_commands`)
2. **Auto-approve enabled** → approve and persist result with `autoApproved: true`
3. **Otherwise** → show approval card in UI and wait for user response

### File Edit Approval (`src/utils/fileSensitivity.ts`)
File edits go through a separate sensitivity check:
1. Evaluate file path against `sensitiveFilePatterns` (**last-match-wins** pattern order)
2. If file is sensitive and `auto_approve_sensitive_edits` is `false` → show approval card with diff
3. Non-sensitive files are written directly without approval

> ⚠️ **INVERTED BOOLEAN — READ CAREFULLY**
>
> In `sensitiveFilePatterns`, `true` means **auto-approve** (file is NOT sensitive).
> `false` means **require approval** (file IS sensitive).
>
> The boolean answers "is this file safe to auto-approve?" — NOT "is this file sensitive?".
>
> ```typescript
> // ✅ CORRECT: .env requires approval → set to false
> { pattern: '**/.env', value: false }
>
> // ❌ WRONG: Don't set .env to true thinking "yes it's sensitive"
> { pattern: '**/.env', value: true }  // This DISABLES approval!
> ```

### UI Flow for Approvals

Both terminal and file edit approvals follow the **persist+post sequence** defined in CRITICAL RULE #1 of `copilot-instructions.md`. The full event ordering table is there. Here is the approval-specific flow:

```
1. persistUiEvent + postMessage → 'showToolAction' (status: 'pending')
2. persistUiEvent + postMessage → 'requestToolApproval' | 'requestFileEditApproval'
   ── wait for user response ──
3. persistUiEvent + postMessage → 'toolApprovalResult' | 'fileEditApprovalResult'
4. [execute command / apply edit]
5. persistUiEvent + postMessage → 'showToolAction' (status: 'success' | 'error')
```

**Key rule**: Every `postMessage` MUST have a matching `persistUiEvent` in the same order. See CRITICAL RULE #1 for the full event table and debugging guide.

## Adding a New Tool

1. Add to `toolRegistry.ts` in `registerBuiltInTools()`:
```typescript
this.register({
  name: 'my_tool',
  description: 'What this tool does',
  schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Param description' }
    },
    required: ['param1']
  },
  execute: async (params, context) => {
    // Implementation
    return 'Result string';
  }
});
```

2. Add UI representation in `getToolActionInfo()` in `src/views/toolUIFormatter.ts`

3. Add to Tools section in settings UI

4. Write tests in `tests/extension/suite/agent/toolRegistry.test.ts`
