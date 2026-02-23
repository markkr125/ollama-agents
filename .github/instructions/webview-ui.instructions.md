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
  blocks: Array<TextBlock | ToolsBlock | ThinkingBlock | ThinkingGroupBlock>;
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

interface ThinkingBlock {
  type: 'thinking';
  content: string;
  collapsed: boolean;
}

interface ThinkingGroupBlock {
  type: 'thinkingGroup';
  sections: Array<ThinkingGroupSection>;
  collapsed: boolean;
  streaming: boolean;
  totalDurationSeconds?: number;
}

type ThinkingGroupSection =
  | { type: 'thinkingContent'; content: string; durationSeconds?: number; startTime?: number }
  | ToolsBlock;
```

### ThinkingGroup — Grouped Thinking + Read/Search Tools

For thinking models (`think=true`), the webview groups thinking content and **read/search** tool actions into a single **collapsible `<details>` element** called a ThinkingGroup. This keeps the UI compact: reads, searches, and exploratory actions are bundled under the "Thought for Xs" pill.

**What goes INSIDE the ThinkingGroup:**
- Thinking content sections (`thinkingContent`)
- Read-only progress groups: `Reading files`, `Exploring workspace`, `Searching codebase`, `Analyzing code`, `Inspecting file structure`

**What goes OUTSIDE the ThinkingGroup (at thread level):**
- Write progress groups: `Writing files`, `Modifying files`, `Creating files`
- Text blocks (streamed text is always at thread level)

**Block ordering with ThinkingGroup:**
1. Thread starts with empty text block: `[text]`
2. Thinking starts: `[text, thinkingGroup{thinking₁}]`
3. Read tools inside group: `[text, thinkingGroup{thinking₁, tools₁(reads), thinking₂}]`
4. Write tools close group + appear at thread level: `[text, thinkingGroup{...collapsed}] [tools₂(writes)]`
5. More thinking + tools: new groups can start for subsequent iterations
6. Final summary: append/create text block as last entry

### Write Groups Close the ThinkingGroup

When `handleStartProgressGroup` receives a progress group whose title matches the write pattern (`/\b(writ|modif|creat)/i`), it **closes the active ThinkingGroup first** via `closeActiveThinkingGroup()`. This happens in both:
- **Live handler**: `src/webview/scripts/core/messageHandlers/progress.ts`
- **History builder**: `src/webview/scripts/core/timelineBuilder.ts`

The `isWriteGroupTitle()` regex matches titles like "Writing files", "Modifying files", "Creating config.ts".

### Thinking Block UI

When a model supports `think=true`, its internal reasoning is streamed via `streamThinking` messages and rendered as a collapsible `<details>` element:

- **Live streaming**: Content streams in real-time, `<details>` is **open** (not collapsed).
- **Collapse**: When the backend detects native tool_calls during streaming, it sends `collapseThinking` with accurate `durationSeconds` immediately — the thinking header changes from "Thinking..." → "Thought for 8s" right then, without waiting for the stream to end.
- **Duration accuracy**: `durationSeconds` is computed from `lastThinkingTimestamp - thinkingStartTime` (excludes Ollama's tool_call buffering time). The webview prefers the backend-provided duration; falls back to `Date.now() - startTime` if not provided.
- **Visual style**: Rendered as a 💭 "Thought" pill. No chevron indicator — just a simple toggle.
- **History rebuild**: `timelineBuilder.ts` handles `thinkingBlock` UI events by creating collapsed thinking sections inside ThinkingGroups. Duration is carried in the persisted event payload.

### `closeActiveThinkingGroup(collapse)` — End-of-Generation Behavior

`closeActiveThinkingGroup()` in `streaming.ts` finalizes the active ThinkingGroup. It accepts an optional `collapse` parameter:

```typescript
export const closeActiveThinkingGroup = (collapse = true) => { ... }
```

- **`collapse = true` (default)**: Collapses the `<details>` element. Used when a write group starts (see above) or when clearing messages.
- **`collapse = false`**: Keeps the `<details>` element **open**. Used at generation-end so tool results inside the thinking group remain visible and clickable.

**Call sites:**
| Caller | `collapse` value | Reason |
|--------|-----------------|--------|
| `handleStartProgressGroup` (write group) | `true` (default) | Thinking is done, collapse before showing writes |
| `handleGenerationStopped` | `false` | Keep last thinking group open for user interaction |
| `handleFinalMessage` | `false` | Keep last thinking group open for user interaction |
| `handleClearMessages` | `true` (default) | Clearing everything — collapse doesn't matter |

**Why this matters**: Without `collapse = false` at generation-end, all tool action groups inside the last thinking group would collapse into a "Thought for Xs" pill. Users reported the scroll area shrinking and action groups becoming unclickable — the thinking group `<details>` was collapsing and hiding all its children.

### First-Chunk Streaming Gate

To prevent incomplete markdown (e.g., `**What` rendering as literal text instead of the spinner), the backend applies a **first-chunk gate**:

- **First chunk**: Requires ≥8 word characters (`[a-zA-Z0-9_]`) before sending `streamChunk`. This ensures enough content for meaningful markdown rendering.
- **Subsequent chunks**: Any content with ≥1 word character is sent immediately, since the markdown renderer has prior context to handle partial syntax.
- **While gated**: The webview continues showing the spinner/loading animation.

**Rules**:
- The assistant thread is the only container for tool UI blocks during an assistant response.
- Never render tool blocks as standalone timeline items outside the assistant thread.
- Both live handlers and `timelineBuilder` create an initial empty text block for consistency.

## Progress Group Rendering Modes

`ProgressGroup.vue` has two rendering modes controlled by the `isCompletedFileGroup` computed:

### Flat Mode (File Edits)
When the group is `done` AND every action has both `filePath` and `checkpointId`, the group renders as a flat list of file edits with verb, filename, and `+N -N` diff stats. Clicking a filename opens the diff view.

### Normal Mode (Default)
For all other groups (reads, searches, commands, mixed operations), the group renders with a collapsible header, status icons, and individual action items.

### ⚠️ `isCompletedFileGroup` Guard (Critical Regression Point)
```typescript
const isCompletedFileGroup = computed(() =>
  props.item.status === 'done' &&
  props.item.actions.length > 0 &&
  props.item.actions.every(a => a.filePath && a.checkpointId)
);
```
The `checkpointId` requirement is **critical**. Read actions have `filePath` (for click-to-open) but NOT `checkpointId`. Without this guard, chunked read actions would incorrectly render in flat mode.

### Action Click Handling
- **With `checkpointId`**: Opens file diff view via `openFileChangeDiff(checkpointId, filePath)`
- **Without `checkpointId`**: Opens the source file via `openWorkspaceFile(filePath, startLine)` — used for `read_file` chunks
- **`startLine`**: Optional line number for positioning the cursor (set by chunked read)

### Tree Listing (list_files / search_workspace)
Actions with multi-line `detail` (containing `\n`) render as a tree with connectors:
- `├` for intermediary entries, `└` for the last entry
- Folders are bold and clickable → `revealInExplorer(fullPath)`
- Files are clickable → `openWorkspaceFile(fullPath)`
- `detail` format: `"summary\tbasePath\n📁 name\n📄 name\tsize"` — basePath is tab-separated on the first line for path construction

**Search results** use a similar listing format but without `basePath` (file paths are already relative):
- Format: `"fileCount\n📄 path\tmatchCount"` — no basePath tab on summary line
- Each `📄 path` entry is clickable → `openWorkspaceFile(path)`
- The tab-separated value after the path (e.g. "3 matches") renders as muted text, not as a numeric size

### ⚠️ Folder-Name Prefix in Clickable Paths

Both `list_files` and `search_workspace` produce relative paths via `vscode.workspace.asRelativePath(path, true)`. In **single-root** workspaces, this prepends the folder name (e.g. `"demo-project/src/file.ts"` for a workspace at `/home/user/demo-project/`).

When the user clicks a file in the listing, the webview sends `{ type: 'openWorkspaceFile', path: 'demo-project/src/file.ts' }` to the backend. The handler in `fileChangeMessageHandler.ts` must strip this prefix before joining with the folder URI — otherwise the path doubles:

```typescript
// fileChangeMessageHandler.ts
private stripFolderPrefix(relativePath: string, folder: vscode.WorkspaceFolder): string {
  const prefix = folder.name + '/';
  if (relativePath.startsWith(prefix)) {
    return relativePath.slice(prefix.length);
  }
  return relativePath;
}
```

Both `handleOpenWorkspaceFile` and `handleRevealInExplorer` call `stripFolderPrefix()` before `Uri.joinPath`. They also iterate all workspace folders to find the actual file, so multi-root workspaces work correctly.

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
- `thinkingBlock` - Stores collapsed thinking content for history rebuild
- `filesChanged` - Creates/merges standalone files-changed widget block
- `fileChangeResult` - Removes a single file from widget (after keep/undo)
- `keepUndoResult` - Removes entire widget block (after Keep All / Undo All)

**Not persisted** (transient UI states):
- "Running" status updates that will be replaced by final status
- Intermediate streaming content (only final content is saved as assistant message)
- `streamThinking` / `collapseThinking` — live streaming events (final content persisted as `thinkingBlock`)

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

## Chat Input Architecture

The chat input area (`ChatInput.vue`) follows the VS Code Copilot design:

### Layout (top to bottom inside `.input-box`)

1. **Attached context area** — Implicit context chips (file, selection) + explicit context chips + attach button
2. **Textarea** — Auto-resizing input
3. **Bottom toolbar** — Mode pill picker, model pill picker, tools button (agent mode), send button

### Implicit Context (EditorContextTracker)

The backend sends `editorContext` messages whenever the active editor or selection changes:
- `EditorContextTracker` (`src/views/editorContextTracker.ts`) listens to `onDidChangeActiveTextEditor` and `onDidChangeTextEditorSelection` (debounced 500ms)
- Also fires on `onDidChangeVisibility` (webview panel becomes visible)
- Also fires on webview `ready` message — `chatView.ts` calls `editorContextTracker?.sendNow()` so the implicit chip appears immediately on IDE startup (Pitfall #31)
- Webview stores in `implicitFile` and `implicitSelection` refs (`state.ts`)

**⚠️ Name-format mismatch** (Pitfall #30): `editorContext` sends `activeFile.fileName` as a **basename** (`hello_world.py` via `doc.fileName.split('/').pop()`), while `addContextItem` uses `asRelativePath(uri, true)` for `fileName` (e.g., `demo-project/hello_world.py`). `editorContext` also sends `activeFile.relativePath` which matches the `asRelativePath` format. All dedup checks must compare against **both** fields.

**Implicit file chip behavior** (mirrors VS Code Copilot):
- **Agent mode**: Faded chip with `(+)` button — click to promote to explicit context
- **Non-agent modes**: Active chip — file content auto-included in message sent to model
- User can toggle (disable/re-enable) via click
- Deduplication: hidden if the same file already exists in explicit context. The `showImplicitFile` computed in `ChatInput.vue` checks both `implicitFile.fileName` (basename) and `implicitFile.relativePath` (workspace-relative) against `contextList[].fileName`.

**Implicit selection chip**:
- Always active (not faded), shown with line range
- Pin button adds it to explicit context + clears the implicit chip
- Always included in every message regardless of mode

**On send** (`handleSend` in `actions/input.ts`):
- Explicit context items are always sent
- Implicit selection is always included (content attached directly)
- Implicit file is included in non-agent modes only (content placeholder `__implicit_file__` → backend resolves via `chatMessageHandler.ts`)
- Implicit file dedup also checks both `fileName` and `relativePath` before including

### Reusable Sub-Components

| Component | File | Purpose |
|-----------|------|---------|
| `PillPicker.vue` | `src/webview/components/chat/components/input/PillPicker.vue` | Compact pill button → opens `DropdownMenu` for mode/model selection |
| `DropdownMenu.vue` | `src/webview/components/chat/components/input/DropdownMenu.vue` | Floating dropdown menu (teleported to body), keyboard-navigable, VS Code menu theming |

### Attach Menu (Multi-Source Context)

The attach button (`codicon-attach`) opens a `DropdownMenu` with:
- **Files** → posts `addContextFromFile` → backend opens file picker dialog
- **Current File** → posts `addContextCurrentFile` → backend reads entire active file
- **Terminal** → posts `addContextFromTerminal` → backend reads terminal buffer (ShellIntegration API when available)

### Icons

All icons use `@vscode/codicons` (CSS font imported in `main.ts`). No emoji fallbacks remain in the chat UI.
Key codicon mappings: `codicon-hubot` (agent), `codicon-list-tree` (plan), `codicon-comment-discussion` (ask), `codicon-edit` (edit), `codicon-server` (model), `codicon-tools` (tools), `codicon-send` (send), `codicon-debug-stop` (stop), `codicon-attach` (attach), `codicon-pin` (pin selection).

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

File edit approval cards render diffs using [diff2html](https://github.com/rtfpessoa/diff2html) (side-by-side mode). The diff HTML is generated server-side in `src/agent/execution/approval/diffRenderer.ts` and injected via `v-html`.

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
│       ├── FilesChanged.vue
│       ├── SessionControls.vue
│       ├── input/             ← input area sub-components
│       │   ├── ChatInput.vue
│       │   ├── DropdownMenu.vue
│       │   ├── PillPicker.vue
│       │   └── TokenUsageIndicator.vue
│       └── timeline/          ← timeline rendering sub-components
│           ├── MarkdownBlock.vue
│           ├── ProgressGroup.vue
│           ├── CommandApproval.vue
│           ├── FileEditApproval.vue
│           └── ContextFilesDisplay.vue
└── settings/
    ├── SettingsPage.vue       ← main page (obvious entry point)
    └── components/            ← sub-components only used by SettingsPage
        ├── setup/             ← connection & infrastructure settings
        │   ├── ConnectionSection.vue
        │   ├── ModelsSection.vue
        │   └── AdvancedSection.vue
        └── features/          ← feature-specific settings
            ├── ModelCapabilitiesSection.vue
            ├── ChatSection.vue
            ├── AutocompleteSection.vue
            ├── AgentSection.vue
            └── ToolsSection.vue
```

**Rules for Vue components:**
- ✅ Main page component = folder root (e.g. `chat/ChatPage.vue`).
- ✅ Sub-components = nested `components/` subfolder, further organized into `input/`, `timeline/`, `setup/`, `features/` as needed (e.g. `chat/components/input/ChatInput.vue`).
- ✅ Sub-components import from `'../../../scripts/core/...'` (one extra `../` because of the nesting).
- ✅ Main page imports sub-components via `'./components/Foo.vue'`.
- ✅ Standalone components that have no sub-components (like `HeaderBar.vue`, `SessionsPanel.vue`) stay directly in `components/`.- ✅ Naming: `.vue` files use **PascalCase**, `.ts` files use **camelCase**, folders use **camelCase**. Enforced by `npm run lint:naming`.- ❌ Do NOT put all `.vue` files flat in the same folder — keep main pages and sub-components visually separated.
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

## Files Changed Widget (Standalone State)

The files-changed widget shows which files the agent modified and lets users Keep/Undo changes. It is **NOT** part of the assistant thread blocks — it uses standalone reactive state:

```typescript
// src/webview/scripts/core/state.ts
export const filesChangedBlocks = ref<AssistantThreadFilesChangedBlock[]>([]);
```

### Why Standalone?

The widget is pinned to the bottom of the chat (below the input area), not embedded in the message timeline. This means:
- It is NOT an `AssistantThreadItem.blocks` entry
- `AssistantThreadFilesChangedBlock` is NOT in the thread block union type
- `ChatPage.vue` renders it from `filesChangedBlocks` state, not from timeline items

### Widget Data Flow

| Action | Handler | Effect |
|--------|---------|--------|
| Agent writes files | `handleFilesChanged()` | Creates/merges block in `filesChangedBlocks` by `checkpointId`; re-requests stats on re-edits |
| Stats arrive | `handleFilesDiffStats()` | Populates `additions`/`deletions` on matching files |
| Single keep/undo (click) | `FilesChanged.vue` click handler | **Optimistic UI**: `removeFileOptimistic()` removes file immediately, recalculates totals, cleans up empty checkpointIds/block. THEN sends `keepFile`/`undoFile` to backend. |
| Single keep/undo (response) | `handleFileChangeResult()` | **Safety net only**: removes file if still present (usually already gone from optimistic removal) |
| Keep All / Undo All (click) | `FilesChanged.vue` click handler | **Optimistic UI**: `filesChangedBlocks.value = []` immediately, then sends backend message |
| Keep All / Undo All (response) | `handleKeepUndoResult()` | Removes block (usually already cleared by optimistic UI) |
| Re-edit detected | `handleFilesChanged()` | When all incoming files already exist (`added=false`), still sends `requestFilesDiffStats` to refresh stale stats |
| Session cleared | `handleClearMessages()` | Sets `filesChangedBlocks.value = []` |

### ⚠️ Optimistic UI Pattern (Keep/Undo)

The filesChanged widget uses **optimistic UI** for keep/undo operations. The file is removed from the widget **immediately in the click handler** (inside the Vue component), before the backend round-trip completes. This guarantees Vue reactivity, since the mutation happens in a synchronous component method.

**Why not rely on the message handler?** Three approaches were attempted for handling removal in the `handleFileChangeResult` response handler:
1. `filter()` + reassignment — failed in practice
2. Fully immutable object replacement — failed in practice
3. `triggerRef()` — failed in practice

All three suffered from Vue reactivity quirks with deeply nested reactive arrays inside `ref()`. The optimistic approach bypasses the problem entirely.

**`FilesChanged.vue` → `removeFileOptimistic()`** handles:
- Removing the file from `block.files` via `splice()`
- Recalculating `totalAdditions` / `totalDeletions`
- Cleaning up `checkpointIds` when no files reference a checkpoint
- Clearing `filesChangedBlocks.value = []` when the block becomes empty

**`handleFileChangeResult`** is retained as a **safety net** for edge cases (e.g., session restore where the optimistic handler wasn't active).

### History Restoration

`timelineBuilder.ts` rebuilds `filesChangedBlocks` into a local `restoredFcBlocks` array, then assigns it to `filesChangedBlocks.value` at the end. Key rules:

1. **Merge by checkpointId**: Multiple incremental `filesChanged` events with the same `checkpointId` must merge into one block (add only files not already present)
2. **fileChangeResult removes files**: Splice the resolved file out; remove the block if it's now empty
3. **keepUndoResult removes ALL blocks**: Use a backward loop to remove ALL blocks with matching `checkpointId` (not just the first)

### Component: `FilesChanged.vue`

- Renders from `filesChangedBlocks` (standalone state, not thread blocks)
- Per-file row shows: file icon, relative path, `+N -N` diff stats columns, ✓ (keep) and ↩ (undo) buttons, review icon
- Header shows total file count, total `+N -N`, Keep All and Undo All buttons
- **Nav bar**: Shows "Change X of Y" counter with ◀ / ▶ buttons for cross-file hunk navigation (hunk-level, not file-level). Hidden until `currentChange` and `totalChanges` are set (populated by `reviewChangePosition` message).
- **Active file indicator**: File rows have `files-changed-file--active` class when `block.activeFilePath === file.path`. Styled with a blue left border (`--vscode-focusBorder`) and selection background (`--vscode-list-activeSelectionBackground`).
- Actions are in `src/webview/scripts/core/actions/filesChanged.ts`
- Handlers are in `src/webview/scripts/core/messageHandlers/filesChanged.ts`

### ⚠️ DataCloneError Prevention

Vue reactive `Proxy` arrays cannot be cloned by `postMessage()`. This causes `DataCloneError` at runtime. When passing `checkpointIds` (or any reactive array) to `postMessage`, **always spread into a plain array first**:

```typescript
// ✅ CORRECT: spread to unwrap the Proxy
navigatePrevChange([...props.block.checkpointIds]);

// ❌ WRONG: passes the Proxy directly → DataCloneError
navigatePrevChange(props.block.checkpointIds);
```

This applies to any Vue reactive array passed through `vscodeApi.postMessage()`.

### Nav & Review Actions

| Action | Function | Payload |
|--------|----------|--------|
| Navigate prev | `navigatePrevChange(checkpointIds)` | `{ type: 'navigateReviewPrev', checkpointIds: string[] }` |
| Navigate next | `navigateNextChange(checkpointIds)` | `{ type: 'navigateReviewNext', checkpointIds: string[] }` |
| Open file review | `openFileChangeReview(id, path)` | `{ type: 'openFileChangeReview', checkpointId, filePath }` |
| Open file diff | `openFileChangeDiff(id, path)` | `{ type: 'openFileChangeDiff', checkpointId, filePath }` |

### `AssistantThreadFilesChangedBlock` Fields

```typescript
interface AssistantThreadFilesChangedBlock {
  type: 'filesChanged';
  checkpointIds: string[];          // All checkpoint IDs across agent iterations
  files: FileChangeFileItem[];       // Per-file items with path, action, +/- stats
  totalAdditions?: number;           // Sum across all files
  totalDeletions?: number;
  status: 'pending' | 'kept' | 'undone' | 'partial';
  collapsed: boolean;
  statsLoading: boolean;             // True while waiting for filesDiffStats
  currentChange?: number;            // Current hunk position (1-based)
  totalChanges?: number;             // Total hunks across all files
  activeFilePath?: string;           // Currently navigated file (for highlight)
}
```

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

### Component: `TokenUsageIndicator.vue`

Copilot-style token usage ring + popup. Located in `src/webview/components/chat/components/input/TokenUsageIndicator.vue`, rendered in `ChatInput.vue`'s `.toolbar-right` (before the send button).

**Props**: `visible`, `promptTokens`, `completionTokens`, `contextWindow`, `categories` (all bound from `tokenUsage` reactive state).

**Ring (20px SVG)**: Usage arc colored by level:
- Green (`.level-ok`) — <50% usage
- Yellow (`.level-warning`) — 50–80% usage
- Red (`.level-danger`) — >80% usage

**Popup** (Teleported to `<body>`, positioned bottom-right):
- Context Window header with close ✕ button
- Usage bar: `{used}K / {total}K tokens · {pct}%`
- Category sections: System (Instructions + Tool Definitions), User Context (Messages + Tool Results + Files)
- Warning text when >70%: "Quality may decline as limit nears."
- Closes on Escape key or click-away backdrop

**State**: `tokenUsage` reactive object in `state.ts`. Reset on `generationStarted`, hidden on `generationStopped`. Updated by `handleTokenUsage()` in `streaming.ts`.

**Styles**: `_token-usage.scss` — uses VS Code theme variables (`--vscode-editor-foreground`, `--vscode-badge-background`, etc.).
