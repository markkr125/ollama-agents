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
   └─ executeAgent()
       └─ Loop (max iterations):
           ├─ Send messages to LLM
           ├─ Stream response
           ├─ Parse for <tool_call> blocks
           ├─ If tool calls found:
           │   ├─ Send 'startProgressGroup' to UI
           │   ├─ For each tool:
           │   │   ├─ Send 'showToolAction' (running)
           │   │   ├─ Execute tool via ToolRegistry
           │   │   ├─ Send 'showToolAction' (success/error)
           │   │   └─ Add result to messages
           │   └─ Continue loop
           ├─ If [TASK_COMPLETE]:
           │   └─ Break loop
           └─ Send 'finalMessage' to UI
```

## ToolRegistry (`src/agent/toolRegistry.ts`)

Defines tools available to the agent for autonomous operations.

**Built-in Tools:**
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write content to file |
| `create_file` | Create new file |
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

**Value semantics**: In `sensitiveFilePatterns`, `true` = auto-approve (NOT sensitive), `false` = require approval. The boolean is inverted from what "sensitive" suggests.

### UI Flow for Approvals
Both terminal and file edit approvals follow this persist+post sequence:

```
1. persistUiEvent('showToolAction', { status: 'pending', ... })
2. postMessage('showToolAction', { status: 'pending', ... })
3. persistUiEvent('requestToolApproval' | 'requestFileEditApproval', { ... })
4. postMessage('requestToolApproval' | 'requestFileEditApproval', { ... })
   ── wait for user response ──
5. persistUiEvent('toolApprovalResult' | 'fileEditApprovalResult', { ... })
6. postMessage('toolApprovalResult' | 'fileEditApprovalResult', { ... })
7. [execute command / apply edit]
8. persistUiEvent('showToolAction', { status: 'success'|'error', ... })
9. postMessage('showToolAction', { status: 'success'|'error', ... })
```

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
