---
applyTo: "src/agent/**,src/services/agent/**,src/utils/toolCallParser.ts"
description: "Agent execution flow, tool registry, tool call parser robustness, terminal execution, command safety, file sensitivity, and approval flow"
---

# Agent Tools & Execution

## Agent Executor Architecture — Decomposed Structure

The agent execution logic lives in `src/services/agent/` and follows a **strict single-responsibility decomposition**. The executor was decomposed from a monolithic 800-line class into focused sub-handlers. **This structure is intentional — do NOT merge files back together or add new responsibilities to the orchestrator.**

### File Map & Responsibilities

```
src/services/agent/
├── agentChatExecutor.ts      # ORCHESTRATOR ONLY — wires sub-handlers, runs main loop
├── agentExploreExecutor.ts   # Read-only executor for explore/plan/review modes
├── agentStreamProcessor.ts   # LLM streaming — chunk accumulation, throttled UI emission
├── agentToolRunner.ts        # Tool batch execution — routing, UI events, diff stats, contextual reminders
├── agentSummaryBuilder.ts    # Post-loop — summary generation, final message, filesChanged, scratch cleanup
├── agentPromptBuilder.ts     # Modular system prompt assembly (native + XML + mode-specific)
├── agentContextCompactor.ts  # Conversation summarization when approaching context limit
├── agentSessionMemory.ts     # Structured in-memory notes maintained across iterations
├── projectContext.ts         # Auto-discovers project files (package.json, CLAUDE.md, etc.)
├── approvalManager.ts        # Approval promise lifecycle — waitForApproval / handleResponse
├── agentTerminalHandler.ts   # Terminal commands — safety check, approval, execution
├── agentFileEditHandler.ts   # File edits — sensitivity check, approval, diff preview
└── checkpointManager.ts      # Checkpoints — snapshotting, keep/undo, diff computation
```

### Ownership Rules — Where Does New Code Go?

| If you need to... | Put it in... | NOT in... |
|---|---|---|
| Change LLM streaming, chunk throttling, thinking accumulation | `agentStreamProcessor.ts` | `agentChatExecutor.ts` |
| Change per-tool execution, tool UI events, inline diff stats | `agentToolRunner.ts` | `agentChatExecutor.ts` |
| Change post-loop summary, fallback LLM call, final message | `agentSummaryBuilder.ts` | `agentChatExecutor.ts` |
| Change terminal command safety/approval/execution | `agentTerminalHandler.ts` | `agentToolRunner.ts` |
| Change file edit sensitivity/approval/diff preview | `agentFileEditHandler.ts` | `agentToolRunner.ts` |
| Change checkpoint snapshotting, keep/undo, diff computation | `checkpointManager.ts` | `agentChatExecutor.ts` |
| Change approval promise lifecycle (wait/resolve) | `approvalManager.ts` | handler files |
| Change loop flow, iteration logic, conversation history | `agentChatExecutor.ts` | sub-handler files |
| Change system prompt wording, sections, mode prompts | `agentPromptBuilder.ts` | `agentChatExecutor.ts` |
| Change conversation compaction/summarization | `agentContextCompactor.ts` | `agentChatExecutor.ts` |
| Change session memory tracking | `agentSessionMemory.ts` | `agentChatExecutor.ts` |
| Change project file auto-discovery | `projectContext.ts` | `agentPromptBuilder.ts` |
| Add/change read-only exploration modes | `agentExploreExecutor.ts` | `agentChatExecutor.ts` |

### `AgentChatExecutor` — The Orchestrator

**This class MUST stay thin.** It owns:
- Constructor wiring of sub-handlers
- The main `execute()` while-loop (iteration orchestration)
- `persistUiEvent()` — the shared persist-to-DB helper
- `persistGitBranchAction()` — git branch UI event sequence
- Session memory injection into system prompt
- `parseToolCalls()` — native vs XML extraction dispatch
- `logIterationResponse()` — debug output channel logging
- Pass-through delegates to `checkpointManager` and `approvalManager`

### `AgentExploreExecutor` — Read-Only Modes

Handles explore, plan, and review modes. Key differences from `AgentChatExecutor`:
- **No checkpoints** — read-only tools don't modify files
- **No approval flow** — no writes or destructive commands to approve
- **Tool filtering** — blocks any non-read-only tools the model attempts to call
- **Lower iteration cap** — defaults to 10 (vs 25 for agent mode)
- **Mode-specific prompts** via `AgentPromptBuilder.buildExplorePrompt()` / `buildPlanPrompt()` / `buildSecurityReviewPrompt()`
- Review mode additionally allows `run_terminal_command` (restricted to git read commands in the prompt)

**It does NOT own** streaming, tool execution, diff stats, summary generation, terminal safety, or file sensitivity. Those are in the sub-handlers.

### `AgentStreamProcessor` — LLM Streaming

Owns the `for await (chunk of stream)` loop. Takes a chat request and returns:

```typescript
interface StreamResult {
  response: string;           // Full accumulated response text
  thinkingContent: string;    // Full accumulated thinking/CoT text
  nativeToolCalls: OllamaToolCall[];  // Native tool calls from API
  firstChunkReceived: boolean; // Whether any text was sent to UI
  lastThinkingTimestamp: number; // Timestamp (ms) of last thinking token
  thinkingCollapsed: boolean;    // Whether collapseThinking was already sent
}
```

Handles: thinking token accumulation, native tool_call accumulation, text content accumulation with 32ms throttled UI emission, first-chunk gate (≥8 word chars), `[TASK_COMPLETE]` partial-prefix stripping, partial tool call detection (XML fallback freezing).

#### Early Thinking Collapse on Native Tool Calls

When native `tool_calls` arrive during streaming, the stream processor **immediately** collapses the thinking group rather than waiting for the stream to end:

1. Computes accurate `durationSeconds` from `lastThinkingTimestamp - thinkingStartTime` (excludes Ollama's tool_call buffering time)
2. Sends `collapseThinking` with `durationSeconds` to the webview — thinking header changes from "Thinking..." → "Thought for 8s" instantly
3. Extracts filenames from write_file/create_file tool_call arguments and shows "Writing filename.ts..." in the bottom spinner
4. Sets `thinkingCollapsed = true` so the executor skips sending a duplicate `collapseThinking`

**Why**: Ollama buffers native tool_call content internally (10–80s for large files). Without early collapse, the thinking group header shows "Thinking..." for the entire buffering duration, making it appear the model is still thinking when it's actually generating file content.

**`thinkingStartTime` parameter**: The executor passes `thinkingStartTime` (captured before `streamIteration()`) to the stream processor so it can compute accurate duration without depending on executor state.

### `AgentToolRunner` — Tool Batch Execution

Executes all tool calls in a single iteration as a batch. Routes to terminal handler, file-edit handler, or generic `ToolRegistry.execute()`. Returns:

```typescript
interface ToolBatchResult {
  nativeResults: Array<{ role: 'tool'; content: string; tool_name: string }>;
  xmlResults: string[];
  wroteFiles: boolean;  // Whether any file write succeeded (not skipped)
}
```

Handles: per-tool "running"→"success"/"error" UI events, `persistUiEvent` for each action, inline diff stats computation (`+N -N` badges), incremental `filesChanged` emission, tool result persistence to DB, skipped-action detection.

#### Chunked `read_file` Interception

All `read_file` calls are intercepted **before** the normal tool execution path and routed through `executeChunkedRead()`. This prevents loading entire files into memory.

**Flow:**
1. `isReadFile` check at top of loop → `executeChunkedRead()` → `continue`
2. Resolve path via `resolveWorkspacePath()`
3. Count total lines via streaming (`countFileLines()`)
4. Loop in `CHUNK_SIZE` (100) line chunks:
   - Emit "running" UI action: `Reading ${fileName}` / `lines ${start}–${end}`
   - Stream just that range via `readFileChunk()`
   - Emit "success" UI action: `Read ${fileName}` / `lines ${start}–${end}`
   - Persist the success event
5. Concatenate all chunks, persist a **single** combined tool message to DB
6. Return combined content to LLM

**Key design decisions:**
- `readFile.ts` schema exposes only `path`/`file` — **no `startLine`/`endLine`** — so the LLM cannot bypass chunking
- Each chunk gets its own UI action with `filePath` and `startLine` for click-to-open navigation
- Chunk actions have `filePath` but **no `checkpointId`** — this is critical for `ProgressGroup.vue`'s `isCompletedFileGroup` guard (only file edits with checkpointId render flat)

### `AgentSummaryBuilder` — Post-Loop Finalization

Called once after the while-loop exits. Handles:
- Fallback LLM summary generation (when no accumulated explanation text)
- Tool summary line building (from last 6 tool results)
- Final assistant message persistence to DB
- `finalMessage` emission to webview
- `filesChanged` final emission with checkpoint
- Has its own `persistUiEvent` (does not share the executor's instance)

### Shared Types Location

All core agent types (`Tool`, `ToolContext`, `ExecutorConfig`, `PersistUiEventFn`) live in `src/types/agent.ts`. Both `toolRegistry.ts` and `agentTerminalHandler.ts` re-export them for backward compatibility, but new code should import from `types/agent` directly.

### Sub-Handler Dependency Pattern

Sub-handlers receive their dependencies via constructor injection (not by holding a reference to the executor). This prevents circular dependencies:

```typescript
// PersistUiEventFn type — defined in src/types/agent.ts (shared location)
export type PersistUiEventFn = (
  sessionId: string | undefined,
  eventType: string,
  payload: Record<string, any>
) => Promise<void>;

// Executor binds its own method and passes it down
const persistFn = this.persistUiEvent.bind(this);
this.terminalHandler = new AgentTerminalHandler(..., persistFn, ...);
```

### ⚠️ Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Do This Instead |
|---|---|---|
| Adding streaming logic to `agentChatExecutor.ts` | Executor becomes a god class again | Add to `agentStreamProcessor.ts` |
| Adding per-tool execution logic to `agentChatExecutor.ts` | Same — executor must stay thin | Add to `agentToolRunner.ts` |
| Importing `AgentChatExecutor` from a sub-handler | Creates circular dependency | Use `PersistUiEventFn` callback type instead |
| Making `AgentStreamProcessor` aware of tool execution | Violates streaming ↔ execution boundary | Stream processor returns `StreamResult`, executor decides what to do with it. Exception: the stream processor MAY emit `collapseThinking` and transient `showThinking` spinners on tool_call detection (UI-only, no persistence) |
| Putting DB persistence logic in stream processor | Stream processor should only handle UI emission | Persistence belongs in executor or tool runner |

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
           │
           ├─ [AgentStreamProcessor.streamIteration()]
           │   ├─ Build chat request (with tools[] + think:true if native)
           │   ├─ Stream LLM response via OllamaClient.chat()
           │   │   ├─ Accumulate thinking tokens (chunk.message.thinking)
           │   │   ├─ Accumulate native tool_calls (chunk.message.tool_calls)
           │   │   │   └─ On first tool_call: collapseThinking + "Writing file..." spinner
           │   │   ├─ Accumulate text content (chunk.message.content)
           │   │   └─ Throttled streamChunk to UI (32ms, first-chunk gate ≥8 word chars)
           │   └─ Return StreamResult { response, thinkingContent, nativeToolCalls, thinkingCollapsed }
           │
           ├─ [Back in agentChatExecutor.execute()]
           │   ├─ De-duplicate thinking echo in response
           │   ├─ Persist thinking block (if any) — skip collapseThinking if stream already sent it
           │   ├─ Process per-iteration delta text
           │   ├─ Check [TASK_COMPLETE] → validate writes → break
           │   └─ parseToolCalls() → native or XML extraction
           │
           ├─ If tools found:
           │   ├─ Persist + post 'startProgressGroup'
           │   ├─ Push assistant message to history (with thinking + tool_calls)
           │   │
           │   ├─ [AgentToolRunner.executeBatch()]
           │   │   ├─ For each tool:
           │   │   │   ├─ [write_file] → CheckpointManager.snapshotFileBeforeEdit()
           │   │   │   │                → AgentFileEditHandler.execute()
           │   │   │   │                  → fileSensitivity → approval flow
           │   │   │   ├─ [Terminal cmd] → AgentTerminalHandler.execute()
           │   │   │   │                  → commandSafety → approval flow
           │   │   │   ├─ [Other tool] → ToolRegistry.execute()
           │   │   │   ├─ Persist tool result to DB
           │   │   │   ├─ Persist + post 'showToolAction' (success/error)
           │   │   │   └─ Compute inline diff stats (+N -N badge)
           │   │   └─ Return ToolBatchResult { nativeResults, xmlResults, wroteFiles }
           │   │
           │   ├─ Persist + post 'finishProgressGroup'
           │   └─ Feed tool results back into conversation history
           │
           └─ Continue to next iteration
       │
       ├─ [AgentSummaryBuilder.finalize()]
       │   ├─ Generate fallback LLM summary (if no accumulated text)
       │   ├─ Persist final assistant message to DB
       │   ├─ Post 'finalMessage' to webview
       │   ├─ Persist + post 'filesChanged' with checkpointId (if files modified)
       │   └─ Return { summary, assistantMessage }
       │
       └─ Return { summary, assistantMessage, checkpointId }
   ← Back in handleAgentMode():
       → reviewService.startReviewForCheckpoint(checkpointId)
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

Manages tool registration, lookup, and execution. The registry itself is a slim class (~110 LOC) — individual tool implementations live in `src/agent/tools/`, one file per tool.

### Tool File Structure

```
src/agent/tools/
├── index.ts              # Barrel export — builtInTools[] array
├── pathUtils.ts          # resolveWorkspacePath(), resolveMultiRootPath() shared utility
├── symbolResolver.ts     # Shared position resolution for LSP tools
├── readFile.ts           # read_file tool
├── writeFile.ts          # write_file tool
├── searchWorkspace.ts    # search_workspace tool (ripgrep-based)
├── listFiles.ts          # list_files tool
├── runTerminalCommand.ts # run_terminal_command tool
├── getDiagnostics.ts     # get_diagnostics tool
├── getDocumentSymbols.ts # get_document_symbols tool (LSP)
├── findDefinition.ts     # find_definition tool (LSP)
├── findReferences.ts     # find_references tool (LSP)
├── findImplementations.ts # find_implementations tool (LSP)
├── findSymbol.ts         # find_symbol tool (LSP)
├── getHoverInfo.ts       # get_hover_info tool (LSP)
├── getCallHierarchy.ts   # get_call_hierarchy tool (LSP)
└── getTypeHierarchy.ts   # get_type_hierarchy tool (LSP)
```

### Shared Types (`src/types/agent.ts`)

All core agent types are centralised in `src/types/agent.ts`:
- `Tool` — tool definition (name, description, schema, execute)
- `ToolContext` — runtime context for tool execution
- `ExecutorConfig` — agent loop configuration (maxIterations, toolTimeout, temperature)
- `PersistUiEventFn` — callback type for DB persistence

`toolRegistry.ts` and `agentTerminalHandler.ts` re-export these types for backward compatibility.

**Built-in Tools (14 total):**

*Core tools:*
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents (streaming, chunked in 100-line blocks via `countFileLines` + `readFileChunk`; see `src/agent/tools/readFile.ts`) |
| `write_file` | Write/create file (handles both) |
| `list_files` | List directory contents (output includes `basePath` for click handling) |
| `search_workspace` | Search for text or regex patterns in files (ripgrep-based; supports `isRegex` flag for case-insensitive, alternatives, wildcards) |
| `run_terminal_command` | Execute shell commands |
| `get_diagnostics` | Get file errors/warnings |

*LSP-powered code intelligence tools (all delegate to `vscode.commands.executeCommand` → active language server):*
| Tool | VS Code Command | Description |
|------|----------------|-------------|
| `get_document_symbols` | `vscode.executeDocumentSymbolProvider` | File outline — classes, functions, methods with line ranges + nesting. Cheapest way to understand file structure. |
| `find_definition` | `vscode.executeDefinitionProvider` | Go-to-definition — follow a function/method call to its source across files. |
| `find_references` | `vscode.executeReferenceProvider` | Find all usages of a symbol across the workspace, grouped by file (capped at 30). |
| `find_implementations` | `vscode.executeImplementationProvider` | Find concrete implementations of interfaces/abstract classes/methods. |
| `find_symbol` | `vscode.executeWorkspaceSymbolProvider` | Search symbols (functions, classes) by name across workspace using the language server index. |
| `get_hover_info` | `vscode.executeHoverProvider` | Type signatures, JSDoc/docstrings, and parameter info for any symbol. |
| `get_call_hierarchy` | `vscode.prepareCallHierarchy` + `provideIncomingCalls`/`provideOutgoingCalls` | Call chain tracing — incoming (who calls this?) and/or outgoing (what does this call?). |
| `get_type_hierarchy` | `vscode.prepareTypeHierarchy` + `provideSupertypes`/`provideSubtypes` | Inheritance chain — supertypes and subtypes of a class/interface. |

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

## Path Resolution (`src/agent/tools/pathUtils.ts`)

All built-in tools resolve file paths through `resolveWorkspacePath()` (single-root) or `resolveMultiRootPath()` (multi-root capable).

### `resolveMultiRootPath` — Folder-Name Prefix Stripping

`vscode.workspace.asRelativePath(path, true)` returns paths prefixed with the workspace folder name (e.g. `"demo-project/rss-fetch.ts"` for a workspace at `/home/user/demo-project/`). When this value is used as a relative path and joined with the folder's URI, the folder name doubles:

```
"demo-project/rss-fetch.ts" joined with /home/user/demo-project/
 → /home/user/demo-project/demo-project/rss-fetch.ts  ← WRONG (ENOENT)
```

`resolveMultiRootPath` handles this in its **single-root fast path**:

1. Checks if `relativePath` starts with `folderName + '/'`
2. Constructs both the prefixed path (`folder/folderName/rest`) and the stripped path (`folder/rest`)
3. Uses `fs.existsSync()` to disambiguate:
   - If the prefixed path **doesn't exist** but the stripped path **does** → use stripped (it was a folder-name prefix)
   - If the prefixed path **does exist** → keep it (there's a real subdirectory with that name)
4. This guard prevents breaking projects that actually have a subdirectory named the same as the workspace folder

**Multi-root path** has a separate handling: step 4 of the resolution order interprets the first path segment as a workspace folder **name** and strips it.

### `search_workspace` — Regex Support & Output Format

The tool supports both plain-text and regex searches via the `isRegex` parameter. The LLM is guided toward regex through:

1. **Tool description**: Explains when to use `isRegex=true` (uncertain casing, alternatives, wildcards)
2. **Schema**: `query` and `isRegex` field descriptions mention `(?i)`, `|`, `.*` syntax
3. **System prompt**: Both native tool-calling and XML fallback system prompts include a `SEARCH TIPS` section with concrete examples

**Output format** (consumed by `toolUIFormatter.ts` for UI rendering):
```
── src/services/myService.ts ──
  10: context line before
→ 11: matching line here
  12: context line after

── src/utils/helper.ts ──
→ 5: another match
```

- `── file ──` headers mark file boundaries
- `→ N:` marks matching lines (with line number)
- Indented lines without `→` are context lines

The UI formatter (`getToolSuccessInfo` for `search_workspace`) parses this format into a structured listing with `📄 path\tmatchCount` entries, displayed in the progress group as a clickable file tree.

## LSP-Powered Code Intelligence Tools

The agent has 8 tools that delegate to VS Code's built-in Language Server Protocol commands (`vscode.commands.executeCommand`). These work for **any language** that has a VS Code extension with LSP support (TypeScript, Python, Java, Rust, etc.) — the agent gets "go to definition", "find references", "document outline", type info, and call hierarchy for free with zero custom parsing.

### Why LSP Tools Matter

Without LSP tools, the agent can only do text search (`search_workspace`) and manual file reading (`read_file`). With them:
- **`get_document_symbols`** gives the agent a file's structure (classes, functions, line ranges) in one call vs reading the entire file
- **`find_definition`** lets the agent follow function calls across files — the single most important tool for deep code understanding
- **`find_references`** shows impact surface before modifying shared code
- **`find_symbol`** finds a class/function by name without knowing which file it's in (uses the language server's semantic index, not raw text search)
- **`get_hover_info`** gives type signatures + JSDoc without navigating to definition files
- **`get_call_hierarchy`** traces call chains — incoming (who calls this?) and outgoing (what does this call?)
- **`find_implementations`** finds concrete classes implementing an interface
- **`get_type_hierarchy`** shows inheritance chains — supertypes and subtypes

### Shared Position Resolution (`symbolResolver.ts`)

Multiple LSP tools need to convert `{path, symbolName?, line?, character?}` into a precise `{uri, position}`. This is centralised in `src/agent/tools/symbolResolver.ts`:

**Resolution strategy:**
1. If `line` + `character` are both provided → use directly (1-based → 0-based conversion)
2. If `symbolName` is provided → search the document text for the symbol
   - If `line` is also given → prefer the occurrence closest to that line
   - Falls back to case-insensitive search if exact match not found
3. If only `line` is given → use with character 0

**Why symbolName?** LLMs are better at naming symbols than specifying exact positions. The agent can say `find_definition({path: "src/main.ts", symbolName: "handleRequest"})` instead of needing to know the exact line/column.

**Exported utilities:**
| Function | Purpose |
|----------|---------|
| `resolveSymbolPosition(params, workspace, allFolders)` | Path + name/position → `{ uri, position }` |
| `readContextAroundLocation(uri, line, contextLines)` | Read surrounding lines (with `→` marker on target line) |
| `formatLocation(location, contextLines)` | Format a `Location`/`LocationLink` to readable string |

### Execution Routing

All LSP tools (and all other non-terminal, non-file-edit tools) go through the standard `ToolRegistry.execute()` path with **no special routing** in `agentToolRunner.ts`. Unlike `write_file` (approval) or `run_terminal_command` (safety), these are read-only and need no approval flow.

### LSP Tool Availability

LSP results depend on having an active language server for the file type:
- TypeScript/JavaScript: Built-in TS server — always available
- Python, Java, Rust, etc.: Requires the user to have the language extension installed
- Plain text files or unsupported languages: Tools return "No X found" messages (graceful degradation, not errors)

### Progress Group Titles for LSP Tools

`getProgressGroupTitle()` in `toolUIFormatter.ts` categorizes LSP tool batches:
- `find_definition`, `find_references`, `find_implementations`, `get_hover_info`, `get_call_hierarchy`, `get_type_hierarchy` → **"Analyzing code"**
- `find_symbol` (grouped with `search_workspace`) → **"Searching codebase"**
- `get_document_symbols` (without writes) → **"Inspecting file structure"**

### System Prompt Guidance

Both native tool-calling and XML fallback system prompts include two key guidance sections:

**1. `USER-PROVIDED CONTEXT` section** — tells the LLM that code blocks attached by the user are already available inline and should NOT be re-read with `read_file`. See "User-Provided Context Pipeline" below.

**2. `CODE NAVIGATION STRATEGY` section** — tells the LLM **when** to use each tool:
- Use `get_document_symbols` before reading large files
- Use `find_definition` to follow function calls
- Use `find_references` before modifying shared code
- Use `find_symbol` when you don't know which file a symbol is in
- Use `get_hover_info` for type/signature inspection
- Use `get_call_hierarchy` for call chain tracing
- Use `find_implementations` for interface/abstract implementations
- Use `get_type_hierarchy` for inheritance chains

This guidance is in `buildAgentSystemPrompt()` in `agentChatExecutor.ts`.

## User-Provided Context Pipeline

When a user attaches code (selected lines or whole files) to a chat message, the content flows through a multi-stage pipeline before reaching the LLM. Understanding this pipeline prevents the common bug where the agent **ignores provided context and re-reads the entire file**.

### Data Flow

```
Editor selection / active file
  → EditorContextTracker.ts: sends editorContext payload to webview
    → Webview state.ts: stores as implicitFile / implicitSelection
      → User pins selection or sends message
        → handleSend() / pinSelection() in actions/input.ts + actions/implicitContext.ts
          → Builds ContextFileRef[] array with {fileName, content, kind}
            → postMessage({type: 'sendMessage', text, context: ContextFileRef[]})
              → chatMessageHandler.ts: resolves __implicit_file__ markers
                → Formats contextStr with descriptive labels
                  → Prepends to user message as fullPrompt
                    → LLM sees context at start of user turn
```

### Context String Format (sent to LLM)

The context is formatted with **descriptive labels** that signal to the LLM that the code is already available:

```
User's selected code from search-node-master/src/ProcessSearch.ts:L409-L843 (already provided — do not re-read):
```
<actual selected code>
```

Contents of config.ts (already provided — do not re-read):
```
<file contents>
```

User's actual question text here
```

The labels are constructed in `chatMessageHandler.ts`:
- **Selections** (fileName contains `:L<digits>`): `User's selected code from <fileName> (already provided — do not re-read):`
- **Whole files**: `Contents of <fileName> (already provided — do not re-read):`

### System Prompt Reinforcement

`buildAgentSystemPrompt()` includes a `USER-PROVIDED CONTEXT` section that reinforces the labels:

```
USER-PROVIDED CONTEXT:
The user may attach code from their editor to the message. This appears at the start of their message in blocks like:
  [file.ts:L10-L50] (selected lines 10–50)
  [file.ts] (whole file)
The code inside those blocks is ALREADY AVAILABLE to you — do NOT re-read it with read_file.
Use the provided content directly for analysis, explanation, or edits.
Only use read_file if you need lines OUTSIDE the provided range, or a different file entirely.
```

This two-level approach (descriptive labels in the user message + explicit instruction in the system prompt) helps the LLM understand it already has the code and should not waste tool calls re-reading it.

### Context Kinds

| Kind | When | fileName Format | Content |
|------|------|----------------|----------|
| `implicit-selection` | User has text selected in editor | `folder/file.ts:L10-L50` | Actual selected text |
| `implicit-file` | Active file in editor (non-agent modes only) | `folder/file.ts` | First 8000 chars of file |
| `explicit` | User manually attached via attach button | `folder/file.ts` or `folder/file.ts:L10-L50` | File/selection content |

### Multi-Root Workspace Paths

In multi-root workspaces, `relativePath` includes the workspace folder name prefix (e.g. `search-node-master/src/ProcessSearch.ts`). This is derived from `vscode.workspace.asRelativePath(uri, true)` and propagated through the full chain:
- `EditorContextTracker` → `activeFile.relativePath` / `activeSelection.relativePath`
- Webview state → `implicitFile.relativePath` / `implicitSelection.relativePath`
- `pinSelection()` / `handleSend()` → used as `fileName` in context items
- `chatMessageHandler.ts` → uses relative paths for `__implicit_file__` resolution

### Key Files

| File | Role |
|------|------|
| `src/views/editorContextTracker.ts` | Sends `editorContext` with `relativePath` to webview |
| `src/webview/scripts/core/state.ts` | Stores `implicitFile` / `implicitSelection` with `relativePath` |
| `src/webview/scripts/core/actions/input.ts` | `handleSend()` — builds context array, uses relativePath for fileNames |
| `src/webview/scripts/core/actions/implicitContext.ts` | `pinSelection()` — stores content + relativePath-based fileName |
| `src/views/messageHandlers/chatMessageHandler.ts` | Resolves `__implicit_file__` markers, formats contextStr with descriptive labels |
| `src/services/agent/agentChatExecutor.ts` | `buildAgentSystemPrompt()` — includes USER-PROVIDED CONTEXT section |

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

> **Full step-by-step guide**: See the `add-agent-tool` skill (`.github/skills/add-agent-tool/SKILL.md`).

Each tool lives in its own file under `src/agent/tools/`. Quick summary:

1. **Create tool file** — `src/agent/tools/myTool.ts` exporting a `Tool` object (`{ name, description, schema, execute }`).
2. **Register in barrel** — Add to `builtInTools[]` in `src/agent/tools/index.ts`.
3. **Add UI mapping** — Add a `case` in `getToolActionInfo()` in `src/views/toolUIFormatter.ts`.
4. **Add to Settings UI** (if toggleable) — `src/webview/components/settings/components/ToolsSection.vue`.
5. **Write tests** — `tests/extension/suite/agent/toolRegistry.test.ts`.

Execution routing: `agentToolRunner.ts` calls `ToolRegistry.execute()` for standard tools. Terminal commands and file edits have dedicated sub-handlers (`agentTerminalHandler.ts`, `agentFileEditHandler.ts`).
