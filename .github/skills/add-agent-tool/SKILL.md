---
name: add-agent-tool
description: "Step-by-step guide for adding a new tool to the Ollama Copilot agent. Use when asked to create, register, or implement a new agent tool, or when adding capabilities to the autonomous coding agent."
---

# Adding a New Agent Tool

Follow these steps to add a new tool that the agent can use during autonomous operations.

## Step 1: Register the Tool

Add to `src/agent/toolRegistry.ts` in `registerBuiltInTools()`:

```typescript
this.register({
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
    // context.workspaceRoot is available for file operations
    // Implementation here
    return 'Result string shown to LLM';
  }
});
```

### Argument Flexibility

For tools that accept file paths, accept multiple argument names for robustness (LLMs may use different names):

```typescript
const filePath = params.path || params.file || params.filePath;
```

The existing tools `read_file`, `write_file`, and `get_diagnostics` all follow this pattern.

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

## Step 3: Add to Settings UI (if toggleable)

If the tool should be individually enable/disable-able, add it to the Tools section in the settings page (`src/webview/components/settings/components/ToolsSection.vue`).

## Step 4: Write Tests

Add tests in `src/test/suite/agent/toolRegistry.test.ts`:

```typescript
test('my_tool: basic functionality', async () => {
  const result = await toolRegistry.executeTool('my_tool', {
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

- [ ] Tool registered in `toolRegistry.ts` with clear description and schema
- [ ] UI representation in `toolUIFormatter.ts`
- [ ] Tests covering happy path and argument flexibility
- [ ] Settings toggle (if applicable)
- [ ] Instructions updated (if new conventions introduced)
