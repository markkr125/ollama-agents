---
applyTo: "src/webview/**"
description: "Webview UI conventions, Vue component patterns, CSS theming, and assistant thread structure"
---

# Webview UI Rules

## ⚠️ Webview Sandbox Boundaries

### NEVER Import `vscode` in Webview Code

Files under `src/webview/**` run inside a **sandboxed iframe**. The `vscode` Node module does **not** exist in this context. Any `import * as vscode from 'vscode'` or `require('vscode')` will:
- ✅ Compile without errors (TypeScript sees the `@types/vscode` declarations)
- ❌ **Crash at runtime** — the module is not available in the webview sandbox

**How to communicate with the extension host instead:**
```typescript
// In src/webview/scripts/core/state.ts (already done — do NOT duplicate)
const vscodeApi = acquireVsCodeApi();

// Send message TO the extension:
vscodeApi.postMessage({ type: 'myMessage', ... });

// Receive messages FROM the extension:
window.addEventListener('message', (event) => { /* event.data */ });
```

**Allowed imports in webview code:**
- ✅ Vue, vue-router, other npm packages bundled by Vite
- ✅ Relative imports within `src/webview/`
- ✅ Type-only imports from `src/types/` (e.g., `import type { SessionRecord } from '../../types/session'`)
- ❌ `vscode` module (runtime crash)
- ❌ `src/services/*`, `src/views/*`, `src/agent/*` (these import `vscode` internally)

### `acquireVsCodeApi()` — Import-Time Side Effect

`acquireVsCodeApi()` is called **at import time** in `src/webview/scripts/core/state.ts`. This means:

1. **Any module that imports `state.ts`** (directly or transitively) triggers the call immediately.
2. **In tests**, this function doesn't exist. The stub is set up in `tests/webview/setup.ts` via Vitest's `setupFiles` — this runs *before* any test imports.
3. **If you create a new webview module** that imports from `state.ts`, `actions/`, `computed.ts`, or `messageHandlers/`, it will work in the browser but **crash in tests** unless the setup file is loaded first.
4. **Never call `acquireVsCodeApi()` a second time** — VS Code throws if it's called more than once. Always import the existing `vscodeApi` from `state.ts`.

## Assistant Thread UI Structure

The webview represents each assistant response as a **single assistant thread item** with a `blocks` array:

```typescript
interface AssistantThreadItem {
  id: string;
  type: 'assistantThread';
  role: 'assistant';
  blocks: Array<TextBlock | ToolsBlock>;
  model?: string;
}

interface TextBlock {
  type: 'text';
  content: string;
}

interface ToolsBlock {
  type: 'tools';
  tools: Array<ProgressItem | CommandApprovalItem>;
}
```

**Block ordering**: Blocks are added sequentially as events occur:
1. Thread starts with empty text block: `[{ type: 'text', content: '' }]`
2. When tools start: `[text, { type: 'tools', tools: [...] }]`
3. After tools, more text: `[text, tools, { type: 'text', content: '...' }]`
4. More tools: `[text, tools, text, tools]`
5. Final summary: `[text, tools, text, tools, text]`

**Rules**:
- The assistant thread is the only container for tool UI blocks during an assistant response.
- Never render tool blocks as standalone timeline items outside the assistant thread.
- Both live handlers and `timelineBuilder` create an initial empty text block for consistency.

## UI Event Persistence

UI events (progress groups, tool actions, approvals) are persisted as `__ui__` tool messages:

```typescript
{
  role: 'tool',
  toolName: '__ui__',
  toolOutput: JSON.stringify({
    eventType: 'startProgressGroup' | 'showToolAction' | 'finishProgressGroup' | 'requestToolApproval' | 'toolApprovalResult' | 'requestFileEditApproval' | 'fileEditApprovalResult',
    payload: { ... }
  })
}
```

**Persisted events** (saved to database):
- `startProgressGroup` - Creates new progress group
- `showToolAction` - Adds action to progress group (only final states, not transient "running" states)
- `finishProgressGroup` - Marks group as done/collapsed
- `requestToolApproval` - Creates pending terminal command approval card + "Awaiting approval" action
- `toolApprovalResult` - Updates terminal command approval status and action status
- `requestFileEditApproval` - Creates pending file edit approval card with diff + "Awaiting approval" action
- `fileEditApprovalResult` - Updates file edit approval status and action status

**Not persisted** (transient UI states):
- "Running" status updates that will be replaced by final status
- Intermediate streaming content (only final content is saved as assistant message)

## Editable Command Approvals

Users can edit terminal commands before approval. The edited command must be sent to the backend and executed exactly as edited.

**Required behavior**:
- The command input is editable **only while status is `pending`**.
- Approving sends `{ approvalId, approved: true, command }` to the backend.
- Backend must execute the edited command and echo the final command back in `toolApprovalResult` so the UI reflects what was run.

**Forbidden**:
- ❌ Do NOT ignore user edits and run the original command.
- ❌ Do NOT allow editing after approval.

---

## CSS Theming

The chat UI uses VS Code's CSS variables for theming:

```css
--vscode-editor-background
--vscode-editor-foreground
--vscode-input-background
--vscode-input-foreground
--vscode-input-border
--vscode-focusBorder
--vscode-button-background
--vscode-button-foreground
--vscode-list-hoverBackground
--vscode-scrollbarSlider-background
```

### ⚠️ diff2html CSS (Critical — Do NOT Import Base CSS)

File edit approval cards render diffs using [diff2html](https://github.com/rtfpessoa/diff2html) (side-by-side mode). The diff HTML is generated server-side in `src/utils/diffRenderer.ts` and injected via `v-html`.

**Do NOT import `diff2html/bundles/css/diff2html.min.css`** — not from SCSS and not from JS. The base CSS adds ~17KB of opinionated light-theme styles (white backgrounds, colored borders, heavy line-number boxes) that look terrible in a VS Code dark-theme webview.

Instead, `src/webview/styles/components/_diff2html.scss` contains **self-contained styles** that target only the HTML elements diff2html actually outputs. These styles use VS Code's native diff editor variables:

```css
--vscode-diffEditor-removedLineBackground   /* deletion row bg */
--vscode-diffEditor-removedTextBackground    /* inline <del> highlight */
--vscode-diffEditor-insertedLineBackground   /* insertion row bg */
--vscode-diffEditor-insertedTextBackground   /* inline <ins> highlight */
```

**Key lessons learned:**

1. **SCSS `@import` of CSS files**: Vite does NOT inline `@import 'pkg/file.css'` from SCSS — it leaves it as a raw CSS `@import` in the output. The webview then tries to load it as a local resource and fails silently. JS imports (`import 'pkg/file.css'` in `.ts`) DO get inlined by Vite, but for diff2html we don't want the base CSS at all.

2. **`white-space: pre` on code line containers**: diff2html's HTML has newlines and indentation between `<span>` tags inside `<div class="d2h-code-side-line">`. With `white-space: pre`, those formatting whitespace characters render as actual visible space, creating absurdly tall rows. Use `white-space: nowrap` on the container div; the inner `.d2h-code-line-ctn` span keeps `white-space: pre` to preserve actual code indentation.

3. **Side-by-side mode**: `outputFormat: 'side-by-side'` in `diffRenderer.ts` produces two `.d2h-file-side-diff` panes inside `.d2h-files-diff` (flex container). Each pane has its own table with `.d2h-code-side-linenumber` and `.d2h-code-side-line` (note the `-side-` in class names vs line-by-line mode).

---

## UI Conventions (Chat)

- Assistant responses expose the model name in the payload (`model`) and render it as a bottom-right hover label in the message container.
- Assistant responses show a dashed divider after each assistant message, except for the very last timeline item. Divider style:
  - `border-top: 1px dashed var(--vscode-chat-checkpointSeparator);`
  - `margin: 15px 0;`

### Responsive Sessions Panel

- Sessions is a **full-page view** (page-based navigation), not a sidebar overlay.
- Page switching is controlled by `currentPage` ref (`'chat' | 'settings' | 'sessions'`).
- The webview persists `currentSessionId` and `currentPage` via `vscode.setState()` (debounced 200ms) so collapsing/restoring the sidebar resumes where the user left off.

### Session Management UX

- **Idle session reuse**: Clicking "New Chat" when an idle empty session exists reuses it instead of creating a duplicate. Checked both on the frontend (timeline length ≤ 1) and backend (`findIdleEmptySession()` query).
- **Single-session optimistic deletion**: `deleteSession()` immediately removes the session from the UI and shows a slide-out animation. The backend confirms with a `sessionDeleted` message. If the deleted session was the current one, a new session is created and a full `loadSessions` refresh is sent.
- **Multi-select deletion (deferred, not optimistic)**: The sessions panel has a "Select" mode with checkboxes, "Select All", and batch "Delete (N)" button. Clicking Delete adds IDs to `deletingSessionIds` (visual dimming/spinner) but does **not** remove sessions from the list. The backend shows `vscode.window.showWarningMessage({ modal: true })`. Sessions are only removed from the list when the backend confirms with `sessionsDeleted`. If the user cancels, `sessionsDeleted` arrives with an empty array, which clears `deletingSessionIds` and `selectionMode` without removing anything.
- **LanceDB batch delete**: `databaseService.deleteMultipleSessions()` uses a single batched LanceDB filter (`session_id = "id1" OR session_id = "id2" OR ...`) instead of per-ID sequential deletes, avoiding CPU spikes.
- **Navigation**: `newChat()` and `loadSession()` both set `currentPage = 'chat'` so clicking them from the settings or sessions page navigates back to the chat.
- **Active session highlighting**: `loadSession(id)` sets `currentSessionId.value = id` immediately on the frontend. The `SessionsPanel` template derives the active class from `session.id === currentSessionId` (not from a server-set `session.active` flag), so highlighting is instant.
- **Relative timestamps**: Sessions show "2h ago", "Yesterday", "3d ago" instead of raw times.
- **Initial load indicator**: `sessionsInitialLoaded` ref starts `false` and is set `true` on the first `loadSessions` message. While `false`, the sessions panel shows "Loading conversations..." instead of "No conversations yet".

---

## Vue Component Organization (Page-per-Folder Pattern)

Each major page lives in its own folder under `src/webview/components/`. The **main page component** sits at the folder root, and its **sub-components** live in a nested `components/` subfolder:

```
components/
├── HeaderBar.vue              # Standalone (no sub-components)
├── SessionsPanel.vue          # Standalone (no sub-components)
├── chat/
│   ├── ChatPage.vue           ← main page (obvious entry point)
│   └── components/            ← sub-components only used by ChatPage
│       ├── ChatInput.vue
│       ├── CommandApproval.vue
│       └── ...
└── settings/
    ├── SettingsPage.vue       ← main page (obvious entry point)
    └── components/            ← sub-components only used by SettingsPage
        ├── ConnectionSection.vue
        └── ...
```

**Rules for Vue components:**
- ✅ Main page component = folder root (e.g. `chat/ChatPage.vue`).
- ✅ Sub-components = nested `components/` subfolder (e.g. `chat/components/ChatInput.vue`).
- ✅ Sub-components import from `'../../../scripts/core/...'` (one extra `../` because of the nesting).
- ✅ Main page imports sub-components via `'./components/Foo.vue'`.
- ✅ Standalone components that have no sub-components (like `HeaderBar.vue`, `SessionsPanel.vue`) stay directly in `components/`.
- ❌ Do NOT put all `.vue` files flat in the same folder — keep main pages and sub-components visually separated.
- ❌ Do NOT use barrel `index.ts` files for Vue component re-exports — import `.vue` files directly for better "go to definition" support.

**When adding a new page:**
1. Create `components/mypage/MyPage.vue` as the main component.
2. Extract large template sections into `components/mypage/components/SubComponent.vue`.
3. Wire script logic into a composable at `scripts/core/mypage/composable.ts` + `types.ts`.

**When adding a sub-component to an existing page:**
1. Create the `.vue` file in the page's `components/` subfolder.
2. Import it directly in the parent page component.

## Script / Logic Organization

- All webview source lives under `src/webview/` (no root-level `webview/` folder).
- App wiring and message handling live in `src/webview/scripts/app/App.ts`.
- Shared logic lives in `src/webview/scripts/core/`:
  - State/refs: `state.ts`
  - Computed values: `computed.ts`
  - Actions/helpers: `actions/` (split modules + `actions/index.ts` barrel)
  - Message handlers: `messageHandlers/` (split modules + `messageHandlers/index.ts` router)
  - Timeline rebuild: `timelineBuilder.ts`
  - Types: `types.ts`
- Styles use SCSS with an entry file at `src/webview/styles/styles.scss` and partials grouped under `src/webview/styles/` (base/layout/components/utils).

**Do not reintroduce monoliths**:
- ❌ Avoid resurrecting `src/webview/scripts/core/actions.ts` or `messageHandlers.ts` as large single files.
- ✅ Add new actions in `src/webview/scripts/core/actions/*` and export from `actions/index.ts`.
- ✅ Add new message handlers in `src/webview/scripts/core/messageHandlers/*` and register in `messageHandlers/index.ts`.
- ✅ `App.ts` should only route messages and export barrels.

If you add new functionality, place it in the appropriate folder above and keep files small and single-purpose. Avoid creating new "catch-all" files.

## Modifying the Chat UI

The chat UI is a Vue app under `src/webview/`:
- `App.vue` composes UI subcomponents and contains the `onMounted` hook that sends the `ready` message
- `components/` follows the **page-per-folder** pattern (see above)
- `scripts/app/App.ts` wires message handling and exports state/actions
- `scripts/core/*` holds state, computed values, actions, and types
- `styles/styles.scss` is the SCSS entry; partials live under `styles/`
- `main.ts` bootstraps the Vue app

**Important**: Vue lifecycle hooks like `onMounted` must be called inside a Vue component's `<script setup>` block. Do NOT place them in plain `.ts` files - they won't execute!

Build output goes to `media/` and is loaded by `ChatViewProvider`.
