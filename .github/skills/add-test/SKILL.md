---
mode: agent
description: Step-by-step guide for adding a new test to the project
tools:
  - read_file
  - replace_string_in_file
  - create_file
  - run_in_terminal
  - file_search
  - grep_search
  - semantic_search
---

# Add a Test

How to add a new test to Ollama Copilot. Covers both test harnesses.

---

## Step 1 — Choose the Harness

| If the code under test… | Use | Location |
|--------------------------|-----|----------|
| Uses `vscode` API, extension activation, storage URIs, workspace folders | Extension host (Mocha) | `tests/extension/suite/` |
| Is a backend service (database, HTTP client, session index, terminal) | Extension host (Mocha) | `tests/extension/suite/services/` |
| Is a pure utility (no `vscode` dependency) | Extension host (Mocha) | `tests/extension/suite/utils/` |
| Lives in `src/webview/scripts/core/*` (state, actions, computed, handlers) | Webview (Vitest) | `tests/webview/core/` |
| Is a Vue component | Webview (Vitest) | `tests/webview/components/` |

---

## Step 2 — Create the Test File

### Extension host test

Create `tests/extension/suite/<category>/<moduleName>.test.ts`:

```typescript
import * as assert from 'assert';
// Import from source — note the path prefix
import { myFunction } from '../../../../src/utils/myModule';

suite('myFunction', () => {
  test('returns expected result for valid input', () => {
    const result = myFunction('input');
    assert.strictEqual(result, 'expected');
  });

  test('handles edge case', () => {
    assert.throws(() => myFunction(''), /error message/);
  });
});
```

**Import path reference:**

| Test in | Import prefix to reach `src/` |
|---------|-------------------------------|
| `suite/*.test.ts` | `../../../src/` |
| `suite/agent/*.test.ts` | `../../../../src/` |
| `suite/services/*.test.ts` | `../../../../src/` |
| `suite/utils/*.test.ts` | `../../../../src/` |
| Mock server | `../../mocks/ollamaMockServer` |

**Required conventions:**
- Use `tdd` style: `suite()` + `test()` (not `describe`/`it`)
- Use Node's `assert` module (not `expect`)
- Use `async` test functions when awaiting
- If you need the mock Ollama server: `import { startOllamaMockServer } from '../../mocks/ollamaMockServer';`
- If you need VS Code APIs: `import * as vscode from 'vscode';`

### Webview test (core logic)

Create `tests/webview/core/<moduleName>.test.ts`:

```typescript
import { beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('myModule', () => {
  test('does something', async () => {
    // Dynamic import for fresh module instance
    const state = await import('../../../src/webview/scripts/core/state');
    const myModule = await import('../../../src/webview/scripts/core/myModule');

    state.someValue.value = 'test';
    expect(myModule.computedThing.value).toBe('expected');
  });
});
```

**Critical**: Use `vi.resetModules()` + `await import()` to get fresh module instances. Static imports share state across tests.

### Webview test (Vue component)

Create `tests/webview/components/<ComponentName>.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import MyComponent from '../../../src/webview/components/chat/components/MyComponent.vue';

// Mock dependencies if needed
vi.mock('../../../src/webview/scripts/core/actions', () => ({
  someAction: vi.fn()
}));

describe('MyComponent', () => {
  test('renders with default props', () => {
    const wrapper = mount(MyComponent, {
      props: { /* ... */ }
    });
    expect(wrapper.text()).toContain('expected text');
  });
});
```

**Import path reference for webview tests:**

| Test in | Import prefix to reach `src/webview/` |
|---------|---------------------------------------|
| `core/*.test.ts` | `../../../src/webview/` |
| `components/*.test.ts` | `../../../src/webview/` |

---

## Step 3 — Run and Verify

```bash
# Extension host test
npm test

# Webview test
npm run test:webview

# All tests
npm run test:all
```

No test registration is needed — both harnesses auto-discover `*.test.ts` / `*.test.js` files via globs.

---

## Step 4 — Update Coverage Catalog

After adding the test, update the "Existing test coverage" sections in `.github/instructions/testing.instructions.md` with:
- Suite name and test count
- Brief description of what it covers

---

## Common Patterns

### Testing postMessage calls (webview)

```typescript
import { vscodePostMessage } from '../setup';

test('sends message on action', async () => {
  vscodePostMessage.mockClear();
  const actions = await import('../../../src/webview/scripts/core/actions/index');

  actions.doSomething();

  expect(vscodePostMessage).toHaveBeenCalledWith({
    type: 'expectedMessageType',
    // ...expected payload
  });
});
```

### Testing with the Ollama mock server (extension)

```typescript
import { startOllamaMockServer } from '../../mocks/ollamaMockServer';

suite('MyService', () => {
  test('handles API response', async () => {
    const server = await startOllamaMockServer({ type: 'chatEcho' });
    try {
      const client = new OllamaClient(server.baseUrl);
      const result = await client.listModels();
      assert.ok(result.length > 0);
    } finally {
      await server.close();
    }
  });
});
```

### Testing database services (extension)

```typescript
import * as vscode from 'vscode';
import { MyService } from '../../../../src/services/myService';

function getExtensionUri(): vscode.Uri {
  const ext = vscode.extensions.getExtension('ollama-copilot.ollama-copilot');
  assert.ok(ext);
  return ext.extensionUri;
}

// Create temp dirs for isolated DB testing
async function makeTempDir(prefix: string): Promise<string> {
  const base = path.join(os.tmpdir(), 'ollama-copilot-tests');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, `${prefix}-`));
}
```
