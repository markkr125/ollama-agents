---
applyTo: "tests/**"
description: "Testing guidelines, test harness setup, existing test coverage catalogs, and webview test rules"
---

# Testing Guidelines

## Build Validation (Required)

- After making code changes, ensure the project still compiles successfully.
- Use `npm run compile` to verify the extension and webview build.
- Run `npm run lint:all` to check ESLint, docs structure, and naming conventions.

## Automated Testing (Required)

This repo uses two complementary test harnesses:

1) **Extension host tests (integration-ish)**
- Runner: `@vscode/test-electron` + Mocha
- Command: `npm test`
- Location:
  - Test harness + mocks: `tests/extension/`
  - Test suites: `tests/extension/suite/`
    - `tests/extension/suite/agent/` for agent tools, execution, and approval tests
    - `tests/extension/suite/utils/` for pure utilities (toolCallParser, toolUIFormatter)
    - `tests/extension/suite/database/` for database service tests
    - `tests/extension/suite/views/` for view handler tests
    - `tests/extension/suite/model/` for model-related tests

2) **Webview tests (fast unit/component)**
- Runner: Vitest + jsdom + Vue Test Utils
- Command: `npm run test:webview`
- Location: `tests/webview/`
- Config: `tests/webview/vitest.config.ts`

To run everything locally (recommended before pushing): `npm run test:all`.

## Post-Change Test Requirements (Non-Negotiable)

After **any** code or test change, run the appropriate test suite(s) before considering the work done:

| What changed | Command | Why |
|---|---|---|
| `src/webview/**` only | `npm run test:webview` | Fast Vitest tests for webview logic |
| `src/**` (non-webview) only | `npm test` | Extension host tests (launches VS Code, runs Mocha) |
| Both, or unsure | `npm run test:all` | Runs both harnesses sequentially |
| New test files added | `npm run test:all` | Verify new tests actually run and pass in the correct harness |

**Common mistake**: Creating extension host test files (under `tests/extension/`) but only running `npm run test:webview`. The new tests compile (`tsc --noEmit`) but are never executed. Always run `npm test` when adding/changing extension host tests.

**Common mistake**: Running `npx tsc -p tsconfig.test.json --noEmit` and assuming tests pass. Type-checking only validates types — it does NOT execute the tests. A test can compile cleanly and still fail at runtime.

## ⚠️ Both Harnesses Are Mandatory (Non-Negotiable)

When a feature or bug fix spans both backend (`src/services/`, `src/agent/`, `src/views/`, `src/utils/`) and frontend (`src/webview/`), **BOTH** test harnesses must receive new tests. This is the most commonly neglected rule.

### The Rule

> **If your change touches backend logic AND has UI implications, you MUST write tests in BOTH `tests/extension/` (Mocha) AND `tests/webview/` (Vitest).** Skipping either harness is not acceptable.

### Why This Matters

- **Vitest-only coverage** catches webview rendering/state bugs but misses backend logic errors (wrong data emitted, wrong persistence, wrong tool execution).
- **Mocha-only coverage** catches service/utility bugs but misses how the UI consumes the data (duplicate entries, wrong state transitions, parity mismatches).
- **Type-checking is not testing.** `tsc --noEmit` passing does NOT mean behavior is correct.

### Concrete Examples

| Change | Extension host test (Mocha) | Webview test (Vitest) |
|--------|-----------------------------|-----------------------|
| New tool verb ("Created"/"Edited") | `toolUIFormatter.test.ts`: verify `getToolSuccessInfo` returns correct verb for `_isNew` flag | `ProgressGroup.test.ts`: verify component renders correct text; `parity.test.ts`: verify live === restored |
| New agent tool | `toolRegistry.test.ts`: tool registered, executes correctly | `parity.test.ts`: tool action events produce correct timeline |
| New message type | Handler test in `tests/extension/suite/`: verify correct `postMessage` + `persistUiEvent` | `messageHandlers.test.ts` or `parity.test.ts`: verify handler produces correct blocks |
| File edit approval flow change | Service test: verify approval emission sequence | `parity.test.ts`: verify live/restored parity for the new flow |
| New setting | `settingsHandler.test.ts`: verify setting read/write | `SettingsPage.test.ts`: verify UI binds to setting correctly |

### Enforcement Checklist

Before marking a task as done, verify:

- [ ] Extension host tests cover the backend logic (`npm test` passes)
- [ ] Webview tests cover the UI/state behavior (`npm run test:webview` passes)
- [ ] Both test suites are actually **executed** (not just compiled)
- [ ] `npm run test:all` passes end-to-end

## What to test with Vitest vs `@vscode/test-electron`

Use the two harnesses for different risk profiles:

**Prefer Vitest (tests/webview) when:**
- You're testing UI "business logic" that should be fast, deterministic, and not depend on VS Code.
- The target lives in `src/webview/scripts/core/*` (state/actions/computed) or a Vue component with clear props/events.
- You want tight coverage on edge cases that are painful to validate via a full VS Code host.

Good Vitest targets:
- `src/webview/scripts/core/actions/` (barrel: `index.ts`): debounced search, context packaging for send, tool/approval UI updates, message/thread merging behavior.
- `src/webview/scripts/core/computed.ts`: header/title selection, derived counts, tool timeout conversions.
- Vue components with important contracts:
  - `src/webview/components/chat/components/CommandApproval.vue`: editable command only when `status === 'pending'`; approve sends edited command.
  - `src/webview/components/SessionsPanel.vue`: pagination (`loadMoreSessions`) + selection (`loadSession`) + loading flags.

**Prefer `@vscode/test-electron` (tests/extension) when:**
- You need real VS Code APIs (`vscode`), extension activation, commands, view registration, or storage URIs.
- You're validating backend/service behavior (SQLite sessions, LanceDB messages, ordering/maintenance, tool execution).
- You want to cover multi-module integration flows end-to-end (even if the UI is mocked).

Good `@vscode/test-electron` targets:
- Extension activation and message routing (`ChatViewProvider` → controllers/services).
- `DatabaseService` invariants (timestamps strictly increasing; maintenance never deletes sessions; delete cascades).
- Mocked Ollama/OpenWebUI HTTP interactions (streaming NDJSON, retry, connection test) using the local mock server.

**Rule of thumb:**
- If the bug would show up as "wrong state / wrong UI rendering / wrong postMessage payload", write Vitest.
- If the bug would show up as "VS Code integration broken / storage broken / commands missing / streaming broken", write `@vscode/test-electron`.

**High-ROI next webview tests to add (Vitest):**
- Sessions UI: `SessionsPanel.vue` pagination and selection behavior (load more, click session, correct postMessage payloads).

## Existing test coverage (Vitest)

> File-level summaries only. For per-test details, read the test files directly.

| File | Tests | What It Covers |
|------|-------|----------------|
| `timelineBuilder.test.ts` | 34 | `buildTimelineFromMessages` — block structure, UI event replay, approval flows, thinking blocks, chunked reads, parity with live handlers |
| `messageHandlers.test.ts` | 27 | Live message handlers — streaming, progress groups, approvals, connection/settings, thinking, chunked reads |
| `actions.test.ts` | 10 | UI actions — search, auto-approve, context send, stop generation, settings |
| `computed.test.ts` | 4 | Derived state — temperature formatting |
| `CommandApproval.test.ts` | 2 | Vue component — editable command input only when pending |
| `MarkdownBlock.test.ts` | 4 | Vue component — markdown rendering, caching |
| `ProgressGroup.test.ts` | 24 | Vue component — flat vs normal mode, `isCompletedFileGroup` guard, file clicks, tree listing |
| `SettingsPage.test.ts` | 19 | Settings composable + component — inputs, welcome banner, navigation, model dropdowns |
| `parity.test.ts` | 19 | Live/history structural parity — write_file dedup, edit verbs, multi-file batches |
| `core/filesChanged.test.ts` | 30 | Files-changed widget — merging, diff stats, keep/undo, timeline builder, session restore, re-edit refresh |

## Existing test coverage (Extension Host)

| File | Tests | What It Covers |
|------|-------|----------------|
| `utils/toolCallParser.test.ts` | 35 | Tool call parsing — XML/bracket/bare JSON, balanced extraction, alt arg names, incomplete calls, `knownToolNames` |
| `agent/toolRegistry.test.ts` | 19 | Tool execution — path arg variants, registration, `getToolNames()` |
| `agent/pathUtils.test.ts` | 22 | Path resolution — `resolveWorkspacePath`, `resolveMultiRootPath` (single/multi-root, prefix stripping, fallback) |
| `agent/multiRootTools.test.ts` | 17 | Multi-root integration — read/write/list/search/diagnostics across workspace folders |
| `agent/readFile.test.ts` | 13 | Streaming file I/O — `countFileLines`, `readFileChunk`, boundaries |
| `agent/codeIntelligenceTools.test.ts` | 26 | LSP tools — all 8 tools with normal/empty/missing-params cases |
| `views/toolUIFormatter.test.ts` | 29 | Tool UI text — progress titles, action info, success info, `_isNew` flag |
| `database/sessionIndexService.test.ts` | 8 | SQLite CRUD — sessions, messages, timestamps, FK constraints, CASCADE |
| `database/databaseService.test.ts` | 3 | DB facade — timestamp ordering, maintenance, cascade delete |
| `database/databaseServiceDeletion.test.ts` | — | Session deletion edge cases — cascade, re-deletion safety |
| `database/databaseServiceExports.test.ts` | — | Module export regression — `getDatabaseService` is function |
| `agent/agentFileEditHandler.test.ts` | 10 | File edit handler — single action (no duplicates), `_isNew` flag, persist/post parity, deferred content |
| `agent/subagentIsolation.test.ts` | 20 | Sub-agent emitter — suppressed/pass-through types, title prefixing, immutability |
| `agent/duplicateToolDetection.test.ts` | 18 | Duplicate tool detection — intra-batch, cross-iteration, sliding window, batch cap |
| `agent/explorerModelResolution.test.ts` | 13 | Explorer model — 3-tier fallback, capability resolution (DB + live), caching |
| `agent/agentControlPlane.test.ts` | 12 | `buildToolCallSummary` — individual tools, chaining, LSP tools, unknown fallback |
| `agent/commandSafety.test.ts` | — | Command safety — dangerous detection, platform filtering |
| `views/fileChangeMessageHandler.test.ts` | — | File change handler — stats recomputation, re-edit freshness, review position |

## Webview test rules (important)

- The webview runtime provides `acquireVsCodeApi()`. Our webview state module calls it **at import-time** in `src/webview/scripts/core/state.ts`.
- Therefore, tests MUST stub `acquireVsCodeApi` before importing any webview core modules.
  - This is handled centrally in `tests/webview/setup.ts` via Vitest `setupFiles`.
- Prefer testing logic in `src/webview/scripts/core/*` (state/actions/computed) over directly testing `src/webview/scripts/app/App.ts`.
  - `App.ts` wires `window.addEventListener('message', ...)` and is intentionally more integration-heavy.
- When asserting message sends to the extension, assert calls to the stubbed `postMessage` function.
- Keep tests deterministic: use `vi.useFakeTimers()` for debounced functions (e.g. search) and `vi.setSystemTime()` when IDs/timestamps are time-based.

## Debugging Tests

### Running a Single Test or Suite

**Extension host tests (Mocha):**
```bash
# Run a specific test file by grep pattern
npm test -- --grep "toolCallParser"

# Run tests matching a describe/it name
npm test -- --grep "should parse XML format"
```

**Webview tests (Vitest):**
```bash
# Run a specific test file
npm run test:webview -- tests/webview/core/timelineBuilder.test.ts

# Run tests matching a name pattern
npm run test:webview -- -t "should merge text blocks"

# Verbose output (shows each test name)
npm run test:webview -- --reporter verbose
```

### Debugging with Breakpoints

**Extension host tests**: Use the VS Code debugger with the "Extension Tests" launch configuration (see `.vscode/launch.json`). Set breakpoints in `tests/extension/suite/**` or in `src/**` — the debugger attaches to the VS Code Extension Host process.

**Webview tests**: Use the "Debug Webview Tests" launch configuration which runs Vitest in debug mode. Breakpoints work in both test files (`tests/webview/**`) and source files (`src/webview/**`).

### Common Test Failures & What They Mean

| Error | Cause | Fix |
|-------|-------|-----|
| `acquireVsCodeApi is not defined` | Test imports a webview module but `tests/webview/setup.ts` didn't run first | Ensure `setupFiles` includes `'./setup.ts'` in `tests/webview/vitest.config.ts` |
| `Cannot find module 'vscode'` | Extension test can't find VS Code APIs | Ensure you're running via `npm test` (which uses `@vscode/test-electron`), not `node` or `ts-node` directly |
| Extension tests hang indefinitely | Shell integration not available (CI, headless) or `waitForCommandEnd()` never resolves | Check that the test runner has a display (Xvfb in CI); add timeouts to terminal-dependent tests |
| `vi.resetModules()` doesn't clear state | Modules imported before `resetModules()` keep old references | Call `vi.resetModules()` then re-import the module via dynamic `import()` inside the test |
| Test passes alone but fails in suite | Shared mutable state between tests (e.g., `state.ts` refs) | Use `beforeEach` to reset state; use `vi.resetModules()` for module-level singletons |
| `SQLITE_CONSTRAINT: FOREIGN KEY` | Test tried to insert a message without creating the parent session first | Always call `createSession()` before `addMessage()` — FK constraints are enforced |
