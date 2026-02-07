---
applyTo: "src/services/databaseService.ts,src/services/sessionIndexService.ts,src/views/settingsHandler.ts"
description: "Critical rules for the dual-database architecture (SQLite + LanceDB)"
---

# Database Architecture & Critical Rules

## Dual-Database Design

This extension uses **two separate databases**:

| Database | Technology | Purpose | Location |
|----------|------------|---------|----------|
| Sessions | SQLite (sql.js) | Session metadata (id, title, mode, model, timestamps) | `sessions.sqlite` |
| Messages | LanceDB | Message content + vector embeddings for semantic search | `ollama-copilot.lance/` |

**Critical**: Sessions and messages are stored separately. Any operation that clears one MUST clear the other to maintain consistency.

## ⚠️ NEVER Auto-Delete User Data

**DO NOT** implement automatic deletion or recreation of the messages table. This includes:

- ❌ Auto-recreating tables on schema mismatch errors
- ❌ Auto-dropping tables on corruption detection
- ❌ Silent data deletion to "recover" from errors

**Why**: Automatic deletion destroys user chat history without consent. Users lose valuable conversation context and have no way to recover it.

**Instead**: Provide manual controls in Advanced Settings for destructive operations, with clear warnings via VS Code's native modal dialogs.

## Schema Mismatch Handling

LanceDB can throw errors like `Found field not in schema: <field_name>` when the table schema changes between versions.

**Correct approach**:
1. Log the error for debugging
2. Do NOT automatically recreate the table
3. Let the user manually trigger "Recreate Messages Table" from Advanced Settings if they choose to lose their data

## LanceDB Corruption Patterns

LanceDB stores data in `.lance` directories with metadata files referencing data files. Corruption can occur when:
- Data files are deleted but metadata still references them
- Extension crashes mid-write
- Filesystem issues

**Error signature**: `Not found: .../ollama-copilot.lance/messages.lance/data/<uuid>.lance`

**Handling**: LanceDB corruption is detected during `initLanceDb()` in `src/services/databaseService.ts`. If initialization fails, search is disabled but the extension continues to function. Users can manually trigger "Recreate Messages Table" from Advanced Settings (`src/views/settingsHandler.ts` → `recreateMessagesTable()`) to clear and rebuild the table.

## Message Ordering

Messages must have strictly increasing timestamps to ensure correct display order. The `getNextTimestamp(sessionId)` function in `src/services/sessionIndexService.ts` guarantees this by:
1. On first call for a session (or when switching sessions), querying the database for the max timestamp in that session
2. Caching the `lastTimestamp` and `lastTimestampSessionId` to avoid repeated DB queries
3. Returning `max(Date.now(), lastTimestamp + 1)` for each subsequent message

**Critical**: The timestamp must be fetched from the database on extension restart or session switch, because the in-memory `lastTimestamp` resets to 0. Without this, new messages could get timestamps lower than existing messages, causing them to appear out of order.

## Agent Message Persistence Order

During agent execution, messages must be saved to the database in the exact order they appear in real-time:
1. **User message** - saved immediately when received
2. **Assistant explanation** - saved BEFORE tool execution (if the LLM provides explanation text before calling tools)
3. **Tool messages** - saved as each tool completes
4. **Final summary** - saved after all tools complete

**Why this matters**: If assistant explanations are only saved at the end (after tools), they get timestamps later than the tools, causing incorrect display order when loading from history.

## DatabaseService.close() and LanceDB Background Init

**Critical**: `close()` must await the background `lanceInitPromise` before nulling out state. Without this, closing a `DatabaseService` instance while LanceDB is still initializing in the background can leave corrupt/partial files that cause subsequent instances to fail.

```typescript
if (this.lanceInitPromise) {
  await this.lanceInitPromise.catch(() => { /* already logged */ });
  this.lanceInitPromise = null;
}
```

This prevents race conditions in tests where multiple instances share the same storage directory.

## Clearing All Data

When implementing "clear all data" functionality:
1. Drop/recreate LanceDB messages table via `DatabaseService.recreateMessagesTable()`
2. Clear SQLite sessions via `SessionIndexService.clearAllSessions()`
3. **Refresh the sessions list in the UI** by sending `loadSessions` with an empty array:
   ```typescript
   this.emitter.postMessage({
     type: 'loadSessions',
     sessions: [],
     hasMore: false,
     nextOffset: null
   });
   ```

All three steps are required - clearing databases without refreshing the UI leaves stale sessions visible.

## Webview Dialog Restrictions

Webviews run in a sandboxed iframe without `allow-modals`. This means:
- ❌ `confirm()` throws: "The document is sandboxed, and the 'allow-modals' keyword is not set"
- ❌ `alert()` and `prompt()` also fail

**Solution**: For confirmation dialogs, send a message to the extension backend and use VS Code's native `vscode.window.showWarningMessage()` with `{ modal: true }`:

```typescript
const result = await vscode.window.showWarningMessage(
  'This will delete all chat history. Continue?',
  { modal: true },
  'Delete'
);
if (result === 'Delete') {
  // proceed with deletion
}
```

## Session Storage Overview

- **Storage scope**: Data is stored per-workspace using `ExtensionContext.storageUri` with a fallback to `globalStorageUri` when no workspace is open.
- **Session index**: `SessionIndexService` (sql.js, offset pagination, sorted by `updated_at DESC`).
- **Messages**: LanceDB `messages` table only (no `sessions` table). Legacy LanceDB sessions are migrated to SQLite on startup.
- **Deletion**: `deleteSession()` removes from SQLite and deletes messages in LanceDB.

## Pagination

Session list uses offset-based pagination:

- Backend returns `{ hasMore, nextOffset }`.
- Webview requests `loadMoreSessions` with `{ offset }`.
