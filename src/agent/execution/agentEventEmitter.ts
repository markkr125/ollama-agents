import { DatabaseService } from '../../services/database/databaseService';
import { WebviewMessageEmitter } from '../../views/chatTypes';

// ---------------------------------------------------------------------------
// AgentEventEmitter — unified emit-and-persist abstraction.
//
// Every UI event emitted to the webview MUST also be persisted to the DB
// so session history matches live chat. This class enforces that contract
// at the API level: there is no way to post without persisting.
//
// Eliminates pitfalls #7 (post without persist), #13 (undefined sessionId),
// and #19 (ensureFilesChangedWidget safety net becomes optional).
// ---------------------------------------------------------------------------

/**
 * A unified emitter that guarantees every UI event is both persisted to
 * the database AND posted to the webview, in the correct order.
 *
 * Session ID is resolved once at construction — it can never be
 * accidentally undefined at call sites.
 */
export class AgentEventEmitter {
  constructor(
    protected readonly sessionId: string,
    protected readonly databaseService: DatabaseService,
    protected readonly webviewEmitter: WebviewMessageEmitter
  ) {}

  /**
   * Persist an event to the database AND post it to the webview.
   * The persist happens first so that on crash/reload the DB is consistent.
   */
  async emit(eventType: string, payload: Record<string, any>): Promise<void> {
    await this.persistToDb(eventType, payload);
    this.postToWebview(eventType, payload);
  }

  /**
   * Post a message to the webview WITHOUT persisting.
   * Use sparingly — only for transient UI hints that should NOT appear
   * in session history (e.g., `showThinking`, `hideThinking` spinners,
   * `streamChunk` partial content, `iterationBoundary`).
   */
  post(eventType: string, payload: Record<string, any>): void {
    this.postToWebview(eventType, payload);
  }

  /**
   * Persist a UI event to the DB without posting to the webview.
   * Use sparingly — only when the webview is driven by a different channel
   * (e.g., `filesChanged` that the tool runner posts inline).
   */
  async persist(eventType: string, payload: Record<string, any>): Promise<void> {
    await this.persistToDb(eventType, payload);
  }

  // -------------------------------------------------------------------------

  protected async persistToDb(
    eventType: string,
    payload: Record<string, any>
  ): Promise<void> {
    try {
      await this.databaseService.addMessage(this.sessionId, 'tool', '', {
        toolName: '__ui__',
        toolOutput: JSON.stringify({ eventType, payload })
      });
    } catch (error) {
      console.warn('[AgentEventEmitter] Failed to persist UI event:', eventType, error);
    }
  }

  protected postToWebview(eventType: string, payload: Record<string, any>): void {
    this.webviewEmitter.postMessage({
      type: eventType,
      ...payload,
      sessionId: this.sessionId
    });
  }
}

// ---------------------------------------------------------------------------
// FilteredAgentEventEmitter — for sub-agent mode.
//
// Suppresses specific event types from reaching the webview while still
// persisting ALL events to the database. This replaces the ad-hoc
// `TOOL_UI_TYPES` Set literal in agentExploreExecutor.ts.
// ---------------------------------------------------------------------------

/**
 * Event types that sub-agents are allowed to post to the webview.
 * Everything else is persisted but silently suppressed from the UI.
 *
 * Exported so that `agentExploreExecutor.ts` can reuse the same set for
 * its `silentStreamEmitter` (which filters raw `postMessage` calls that
 * bypass the `FilteredAgentEventEmitter`).
 */
export const SUB_AGENT_ALLOWED_TYPES = new Set([
  'startProgressGroup',
  'finishProgressGroup',
  'showToolAction',
  'showError',
  'showWarningBanner',
  'subagentThinking',
]);

/**
 * A filtered emitter for sub-agent execution. Persists all events to the
 * DB (for session history) but only posts allowed types to the webview
 * (to prevent sub-agent events from corrupting the parent's UI).
 */
export class FilteredAgentEventEmitter extends AgentEventEmitter {
  constructor(
    sessionId: string,
    databaseService: DatabaseService,
    webviewEmitter: WebviewMessageEmitter,
    private readonly allowedTypes: Set<string> = SUB_AGENT_ALLOWED_TYPES
  ) {
    super(sessionId, databaseService, webviewEmitter);
  }

  override async emit(eventType: string, payload: Record<string, any>): Promise<void> {
    await this.persistToDb(eventType, payload);
    if (this.allowedTypes.has(eventType)) {
      this.postToWebview(eventType, payload);
    }
  }
}
