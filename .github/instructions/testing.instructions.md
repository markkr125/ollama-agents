---
applyTo: "tests/**"
description: "Testing guidelines, test harness setup, existing test coverage catalogs, and webview test rules"
---

# Testing Guidelines

## Build Validation (Required)

- After making code changes, ensure the project still compiles successfully.
- Use `npm run compile` to verify the extension and webview build.

## Automated Testing (Required)

This repo uses two complementary test harnesses:

1) **Extension host tests (integration-ish)**
- Runner: `@vscode/test-electron` + Mocha
- Command: `npm test`
- Location:
  - Test harness + mocks: `tests/extension/`
  - Test suites: `tests/extension/suite/`
    - `tests/extension/suite/utils/` for pure utilities
    - `tests/extension/suite/services/` for service-level integration tests

2) **Webview tests (fast unit/component)**
- Runner: Vitest + jsdom + Vue Test Utils
- Command: `npm run test:webview`
- Location: `tests/webview/`
- Config: `tests/webview/vitest.config.ts`

To run everything locally (recommended before pushing): `npm run test:all`.

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

The following test suites exist in `tests/webview/`:

**`timelineBuilder.test.ts`** (23 tests) - Tests the `buildTimelineFromMessages` function:
- Block-based structure: user messages, assistant threads, text block merging
- UI event replay: `startProgressGroup`, `showToolAction`, `finishProgressGroup`
- Command approval flow: `requestToolApproval`, `toolApprovalResult`, skipped status
- **File edit approval flow**: `requestFileEditApproval`, `fileEditApprovalResult`
- Full workflow matching live/history parity
- Edge cases: implicit groups, orphan approvals, invalid JSON handling
- **Critical**: finishProgressGroup converts pending/running actions to success

**`messageHandlers.test.ts`** (11 tests) - Tests live message handlers:
- Streaming handlers: `handleStreamChunk` creates/updates text blocks
- Progress group handlers: start/show/finish progress groups
- Approval handlers with live/history parity: both progress group action AND approval card
- **Critical contract test**: `complete workflow produces same structure as timelineBuilder`
- **Critical contract test**: `file edit approval workflow produces same structure as timelineBuilder`

**`actions.test.ts`** (7 tests) - Tests UI actions:
- Debounced search behavior
- Auto-approve toggle/confirm
- Context packaging for send

**`computed.test.ts`** (4 tests) - Tests derived state:
- Temperature display formatting

**`CommandApproval.test.ts`** (2 tests) - Tests Vue component:
- Editable command input only when status is `pending`

**`MarkdownBlock.test.ts`** (4 tests) - Tests Vue component:
- Renders markdown content via computed property
- Updates when content prop changes
- Caching behavior prevents unnecessary re-renders

## Existing test coverage (Extension Host)

The following test suites exist in `tests/extension/suite/`:

**`utils/toolCallParser.test.ts`** (24 tests) - Tests tool call parsing robustness:
- Basic parsing: XML and bracket format tool calls
- Balanced JSON extraction: nested objects, deeply nested content
- Alternative argument names: `arguments`, `args`, `params`, `parameters`
- Top-level arguments: when LLM puts args at root level
- Alternative tool name fields: `name`, `tool`, `function`
- Incomplete tool calls: LLM cutoff handling, missing closing braces
- Edge cases: escaped quotes, newlines, surrounding text, empty args
- Smart quote normalization: Unicode U+201C and U+201D to regular quotes

**`agent/toolRegistry.test.ts`** (17 tests) - Tests tool execution:
- read_file: accepts `path`, `file`, `filePath` arguments
- write_file: accepts multiple path formats, writes JSON and special characters
- list_files: lists workspace root correctly
- get_diagnostics: accepts multiple path argument names
- Tool registration: verifies all expected tools are registered

**`services/sessionIndexService.test.ts`** (8 tests) - Tests SQLite session/message CRUD:
- Session creation/update/listing with pagination
- Message CRUD with tool fields (tool_name, tool_input, tool_output)
- getNextTimestamp returns strictly increasing values
- Foreign key constraint prevents orphan messages
- CASCADE delete: deleteSession removes messages
- clearAllSessions removes all sessions and messages

**`services/databaseService.test.ts`** (3 tests) - Tests database facade:
- Message timestamps are strictly increasing and persist across restart
- Maintenance returns zero orphans (FK prevents them)
- deleteSession removes session and cascades to messages

**`services/databaseServiceDeletion.test.ts`** - Tests session deletion edge cases:
- Session deletion cascades to messages via FK constraint
- Re-deletion of already-deleted session is safe

**`services/databaseServiceExports.test.ts`** - Regression test for module exports:
- `getDatabaseService` is exported as a function (guards against stale webpack builds)
- `DatabaseService` class is exported

**`utils/commandSafety.test.ts`** - Tests terminal command safety analysis:
- Dangerous command detection (rm -rf, sudo, etc.)
- Platform-specific filtering

## Webview test rules (important)

- The webview runtime provides `acquireVsCodeApi()`. Our webview state module calls it **at import-time** in `src/webview/scripts/core/state.ts`.
- Therefore, tests MUST stub `acquireVsCodeApi` before importing any webview core modules.
  - This is handled centrally in `tests/webview/setup.ts` via Vitest `setupFiles`.
- Prefer testing logic in `src/webview/scripts/core/*` (state/actions/computed) over directly testing `src/webview/scripts/app/App.ts`.
  - `App.ts` wires `window.addEventListener('message', ...)` and is intentionally more integration-heavy.
- When asserting message sends to the extension, assert calls to the stubbed `postMessage` function.
- Keep tests deterministic: use `vi.useFakeTimers()` for debounced functions (e.g. search) and `vi.setSystemTime()` when IDs/timestamps are time-based.
