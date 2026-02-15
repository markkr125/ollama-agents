---
name: add-agent-tool
description: "Step-by-step guide for adding a new tool to the Ollama Copilot agent. Use when asked to create, register, or implement a new agent tool, or when adding capabilities to the autonomous coding agent."
---

# Adding a New Agent Tool

Follow these steps to add a new tool that the agent can use during autonomous operations.

## Step 1: Create the Tool File

Create a new file in `src/agent/tools/` (e.g. `src/agent/tools/myTool.ts`):

```typescript
import { Tool } from '../../types/agent';

export const myToolTool: Tool = {
  name: 'my_tool',
  description: 'What this tool does - be specific so the LLM knows when to use it',
  schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Param description' }
    },
    required: ['param1']
  },
  execute: async (params, context) => {
    // context.workspace is available for file operations
    // Implementation here
    return 'Result string shown to LLM';
  }
};
```

### Argument Flexibility

For tools that accept file paths, accept multiple argument names for robustness (LLMs may use different names). Use the shared `resolveWorkspacePath` utility from `pathUtils.ts`:

```typescript
import { resolveWorkspacePath } from './pathUtils';

const filePath = params.path || params.file || params.filePath;
```

The existing tools `read_file`, `write_file`, and `get_diagnostics` all follow this pattern.

### LSP-Backed Tools (Pattern Reference)

For tools that delegate to VS Code's language server (go-to-definition, find references, etc.), use the shared `symbolResolver.ts` for position resolution and `vscode.commands.executeCommand()` for the LSP command. See `findDefinition.ts` or `getDocumentSymbols.ts` as reference implementations. These tools are read-only and need no special routing — they go through standard `ToolRegistry.execute()`.

## Step 1b: Register in the Barrel Export

Add the new tool to `src/agent/tools/index.ts`:

```typescript
import { myToolTool } from './myTool';

export const builtInTools: Tool[] = [
  // ... existing tools ...
  myToolTool,
];

export { myToolTool };
```

The `ToolRegistry.registerBuiltInTools()` iterates over `builtInTools` and registers them all automatically.

## Step 2: Add UI Representation

In `src/views/toolUIFormatter.ts`, add a case to `getToolActionInfo()` so the UI shows an appropriate icon and description when the tool runs:

```typescript
case 'my_tool':
  return {
    icon: '🔧',
    text: `Running my tool on ${args.param1}`,
    detail: 'Additional detail shown in collapsed view'
  };
```

## Step 3: Understand Execution Routing

Tool execution is handled by the **decomposed agent executor** in `src/services/agent/`. The orchestrator (`agentChatExecutor.ts`) delegates tool execution to `agentToolRunner.ts`, which calls `ToolRegistry.execute()` for standard tools.

**Where to add special execution logic:**
- Standard tools (read/write/search): Create file in `src/agent/tools/` and add to `index.ts` — `agentToolRunner.ts` calls them automatically via `ToolRegistry.execute()`
- Terminal commands: Handled by `agentTerminalHandler.ts` (approval + execution)
- File edits: Handled by `agentFileEditHandler.ts` (sensitivity check + approval)
- New execution category: Create a new sub-handler in `src/services/agent/` — do NOT add logic to `agentChatExecutor.ts`

See `agent-tools.instructions.md` → "Agent Executor Architecture" for the full decomposition rules.

## Step 3: Add to Settings UI (if toggleable)

If the tool should be individually enable/disable-able, add it to the Tools section in the settings page (`src/webview/components/settings/components/ToolsSection.vue`).

## Step 4: Write Tests

Add tests in `tests/extension/suite/agent/toolRegistry.test.ts`:

```typescript
test('my_tool: basic functionality', async () => {
  const result = await toolRegistry.execute('my_tool', {
    param1: 'test-value'
  }, context);
  assert.ok(result.includes('expected output'));
});

// Test argument name flexibility if applicable
test('my_tool: accepts alternative param names', async () => {
  // ...
});
```

## Step 5: Update Instructions

If the tool introduces new conventions or critical rules, update the relevant `.github/instructions/*.instructions.md` file (likely `agent-tools.instructions.md`).

## Checklist

- [ ] Tool file created in `src/agent/tools/` with clear description and schema
- [ ] Tool added to `builtInTools` array in `src/agent/tools/index.ts`
- [ ] UI representation in `toolUIFormatter.ts`
- [ ] Tests covering happy path and argument flexibility
- [ ] `npm run lint:all` passes (ESLint + docs + naming)
- [ ] Settings toggle (if applicable)
- [ ] Instructions updated (if new conventions introduced)
