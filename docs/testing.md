# Testing

How to run, write, and organize tests for Ollama Copilot.

---

## Table of Contents

- [Dual-Harness Architecture](#dual-harness-architecture)
- [Directory Structure](#directory-structure)
- [Running Tests](#running-tests)
- [When to Use Which Harness](#when-to-use-which-harness)
- [Adding a New Extension Test](#adding-a-new-extension-test)
- [Adding a New Webview Test](#adding-a-new-webview-test)
- [Mock Patterns](#mock-patterns)
- [The vi.resetModules + await import Pattern](#the-viresetmodules--await-import-pattern)
- [Naming Conventions](#naming-conventions)
- [Existing Coverage](#existing-coverage)

---

## Dual-Harness Architecture

The project uses **two independent test harnesses** because the extension and webview have fundamentally different runtimes:

| Harness | Runner | Environment | Compile | Style |
|---------|--------|-------------|---------|-------|
| **Extension host** | `@vscode/test-electron` + Mocha | Real VS Code instance | tsc → `out/` (JS) | `tdd` (`suite`/`test`) |
| **Webview** | Vitest + jsdom | Simulated browser (jsdom) | On-the-fly via Vite | `bdd` (`describe`/`test`) |

Extension host tests run inside a real VS Code instance with access to the full `vscode` API, file system, and extension activation. They are compiled by `tsc` into `out/` and discovered at runtime by Mocha's glob.

Webview tests run in a fast jsdom environment with Vue Test Utils. They are compiled on-the-fly by Vite/Vitest and never go through `tsc`.

The two toolchains **cannot be merged** — extension tests need real VS Code APIs (not available in jsdom), and webview tests use Vitest globals + Vue SFCs (not compatible with tsc/Mocha).

---

## Directory Structure

```
tests/
├── extension/                   # @vscode/test-electron + Mocha
│   ├── runTest.ts               # Entry point — launches VS Code + mock server
│   ├── mocks/
│   │   └── ollamaMockServer.ts  # HTTP mock for Ollama API
│   └── suite/
│       ├── index.ts             # Mocha loader (glob discovers *.test.js)
│       ├── extensionActivation.test.ts
│       ├── agent/
│       │   └── toolRegistry.test.ts
│       ├── services/
│       │   ├── databaseService.test.ts
│       │   ├── databaseServiceDeletion.test.ts
│       │   ├── databaseServiceExports.test.ts
│       │   ├── ollamaClient.test.ts
│       │   ├── sessionIndexService.test.ts
│       │   └── settingsHandler.test.ts
│       └── utils/
│           ├── commandSafety.test.ts
│           ├── streamParser.test.ts
│           ├── terminalApproval.test.ts
│           └── toolCallParser.test.ts
└── webview/                     # Vitest + jsdom + Vue Test Utils
    ├── vitest.config.ts         # Vitest config
    ├── setup.ts                 # Global setup (stubs acquireVsCodeApi)
    ├── core/
    │   ├── timelineBuilder.test.ts
    │   ├── messageHandlers.test.ts
    │   ├── computed.test.ts
    │   └── actions.test.ts
    └── components/
        ├── CommandApproval.test.ts
        ├── MarkdownBlock.test.ts
        └── SettingsPage.test.ts
```

**Config files:**
- `tsconfig.test.json` — extends `tsconfig.json` with `rootDir: "."` so tsc can compile both `src/` and `tests/extension/` into `out/`.
- `tests/webview/vitest.config.ts` — Vitest config with `root` set to project root, jsdom environment, and Vue plugin.

---

## Running Tests

```bash
# Run everything (recommended before pushing)
npm run test:all

# Webview tests only (fast — ~2 seconds)
npm run test:webview

# Extension host tests only (slow — launches VS Code)
npm test

# Watch mode for webview tests during development
npx vitest --config tests/webview/vitest.config.ts
```

The `test` script does: `npm run compile` → `tsc -p tsconfig.test.json` → `node ./out/tests/extension/runTest.js`.

The `test:webview` script does: `vitest --config tests/webview/vitest.config.ts run`.

---

## When to Use Which Harness

**Use Vitest** (`tests/webview/`) when the code under test:
- Lives in `src/webview/scripts/core/*` (state, actions, computed, timeline builder, message handlers)
- Is a Vue component with clear props/events
- Does not depend on the `vscode` API
- Benefits from fast iteration and edge-case coverage

**Use `@vscode/test-electron`** (`tests/extension/`) when the code under test:
- Uses real `vscode` APIs (extension activation, commands, storage URIs, workspace folders)
- Is a backend service (database, HTTP client, session index)
- Needs the extension to be activated in a real VS Code host
- Interacts with the file system or terminal in VS Code-specific ways

**Rule of thumb:**
- Bug shows up as "wrong UI state / wrong postMessage payload" → Vitest
- Bug shows up as "VS Code integration broken / storage broken / commands missing" → extension host

---

## Adding a New Extension Test

1. **Create the test file** in `tests/extension/suite/` under the appropriate subdirectory:
   - `agent/` for agent/tool tests
   - `services/` for backend service tests
   - `utils/` for pure utility tests
   - Root of `suite/` for activation/integration tests

2. **Name it** `<module>.test.ts` (e.g., `tokenManager.test.ts`).

3. **Write imports** — source modules are at `../../../../src/`:
   ```typescript
   import * as assert from 'assert';
   import { MyService } from '../../../../src/services/myService';
   ```

4. **Use `tdd` style** (Mocha):
   ```typescript
   suite('MyService', () => {
     test('does something', () => {
       assert.strictEqual(actual, expected);
     });
   });
   ```

5. **No registration needed** — Mocha discovers all `*.test.js` files via glob in `tests/extension/suite/index.ts`.

6. **Verify**: `npm test` (compiles and runs in VS Code host).

### Import path reference for extension tests

| Test location | Import prefix to reach `src/` |
|---------------|-------------------------------|
| `tests/extension/suite/*.test.ts` | `../../../src/` |
| `tests/extension/suite/agent/*.test.ts` | `../../../../src/` |
| `tests/extension/suite/services/*.test.ts` | `../../../../src/` |
| `tests/extension/suite/utils/*.test.ts` | `../../../../src/` |
| Cross-test (mock server) | `../../mocks/ollamaMockServer` |

---

## Adding a New Webview Test

1. **Create the test file** in `tests/webview/` under the appropriate subdirectory:
   - `core/` for state/actions/computed/timeline/message handler tests
   - `components/` for Vue component tests

2. **Name it** `<Module>.test.ts` (PascalCase for components, camelCase for core).

3. **Write imports** — source modules are at `../../../src/webview/`:
   ```typescript
   import { describe, expect, test, vi } from 'vitest';
   // Dynamic import for fresh module (see pattern below)
   const state = await import('../../../src/webview/scripts/core/state');
   // Static import for Vue components
   import MyComponent from '../../../src/webview/components/chat/components/MyComponent.vue';
   ```

4. **Use `bdd` style** (Vitest):
   ```typescript
   describe('MyComponent', () => {
     test('renders correctly', () => {
       expect(actual).toBe(expected);
     });
   });
   ```

5. **No registration needed** — Vitest discovers via the `include` glob in `tests/webview/vitest.config.ts`.

6. **Verify**: `npm run test:webview`.

### Import path reference for webview tests

| Test location | Import prefix to reach `src/webview/` |
|---------------|---------------------------------------|
| `tests/webview/core/*.test.ts` | `../../../src/webview/` |
| `tests/webview/components/*.test.ts` | `../../../src/webview/` |

---

## Mock Patterns

### Ollama Mock Server (extension tests)

A plain Node.js HTTP server that simulates Ollama API responses. Used by `ollamaClient.test.ts` and `settingsHandler.test.ts`.

```typescript
import { startOllamaMockServer } from '../../mocks/ollamaMockServer';

const server = await startOllamaMockServer({ type: 'chatEcho' });
try {
  const client = new OllamaClient(server.baseUrl);
  // ... test against the mock
} finally {
  await server.close();
}
```

### acquireVsCodeApi Stub (webview tests)

The webview runtime provides `acquireVsCodeApi()` globally. The `state.ts` module calls it **at import time**. The setup file at `tests/webview/setup.ts` stubs it before any test module loads:

```typescript
// setup.ts
import { vi } from 'vitest';

export const vscodePostMessage = vi.fn();

vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: vscodePostMessage,
  getState: vi.fn(() => null),
  setState: vi.fn()
}));
```

Tests can import `vscodePostMessage` from `../setup` to assert message sends.

### vi.mock for Module Replacement (webview tests)

Use `vi.mock()` to replace modules before they're imported. The path must match the actual import path:

```typescript
vi.mock('../../../src/webview/scripts/core/actions', () => ({
  formatMarkdown: (text: string) => `<p>${text}</p>`
}));
```

---

## The vi.resetModules + await import Pattern

Webview core modules (`state.ts`, `actions/index.ts`, `computed.ts`, `timelineBuilder.ts`) maintain global reactive state. To get a **fresh module instance** per test (avoiding state leakage between tests), use:

```typescript
beforeEach(() => {
  vi.resetModules();  // Clear module cache
});

test('my test', async () => {
  // Dynamic import gets a fresh instance after resetModules
  const state = await import('../../../src/webview/scripts/core/state');
  const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

  // state is pristine — no leftover values from previous tests
  state.timeline.value = [];
  // ...
});
```

**Why not static imports?** Static `import` statements are resolved once at file load time. After `vi.resetModules()`, only `await import()` fetches the fresh module. Mixing static and dynamic imports of the same module will give you two different instances.

**Combine with fake timers** when testing time-dependent features:

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});
```

---

## Naming Conventions

| Convention | Extension tests | Webview tests |
|------------|----------------|---------------|
| File name | `camelCase.test.ts` | `PascalCase.test.ts` (components), `camelCase.test.ts` (core) |
| Test style | `suite('…')` / `test('…')` (tdd) | `describe('…')` / `test('…')` (bdd) |
| Assertions | `assert.strictEqual()`, `assert.ok()` | `expect().toBe()`, `expect().toEqual()` |
| Async | `async` test functions | `async` test functions |

---

## Existing Coverage

### Webview Tests (77 tests)

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `timelineBuilder.test.ts` | 23 | `buildTimelineFromMessages`: block structure, UI event replay, approval flows, edge cases |
| `messageHandlers.test.ts` | 15 | Live streaming handlers, progress groups, approval handlers, live/history parity contracts |
| `actions.test.ts` | 10 | Debounced search, auto-approve toggle/confirm, context packaging |
| `computed.test.ts` | 4 | Temperature display, tool timeout conversion, header title |
| `SettingsPage.test.ts` | 19 | Settings page rendering, section switching, input binding |
| `MarkdownBlock.test.ts` | 4 | Markdown rendering, content updates, caching |
| `CommandApproval.test.ts` | 2 | Editable input when pending, approve sends edited command |

### Extension Host Tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `toolCallParser.test.ts` | 24 | XML/bracket parsing, balanced JSON, alternative arg names, incomplete calls, smart quotes |
| `toolRegistry.test.ts` | 17 | Tool execution (read/write/list files, diagnostics), argument name variants |
| `sessionIndexService.test.ts` | 8 | SQLite session/message CRUD, pagination, timestamps, FK constraints, cascade delete |
| `databaseService.test.ts` | 3 | Timestamp ordering, maintenance, cascade delete |
| `databaseServiceDeletion.test.ts` | — | Session deletion and cascade behavior |
| `databaseServiceExports.test.ts` | — | Module export regression test (`getDatabaseService`) |
| `ollamaClient.test.ts` | — | Mock API: listModels, testConnection |
| `settingsHandler.test.ts` | — | Race condition regression for saveBearerToken/testConnection |
| `commandSafety.test.ts` | — | Dangerous command detection, platform-specific filtering |
| `streamParser.test.ts` | — | NDJSON stream parsing |
| `terminalApproval.test.ts` | — | Terminal approval decision logic |
| `extensionActivation.test.ts` | 1 | Extension discovery and activation smoke test |
