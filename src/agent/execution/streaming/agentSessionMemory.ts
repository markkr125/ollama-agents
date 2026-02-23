import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// AgentSessionMemory — structured in-memory notes that the agent maintains
// across iterations within a single session. Inspired by Claude Code's
// "scratchpad" + "memory" patterns.
//
// Usage: The executor creates one instance per session. After each iteration,
// it calls `updateFromIteration()` to let the memory self-organize. The
// memory is serialized into a system-level reminder injected before each LLM
// call.
// ---------------------------------------------------------------------------

/** A single structured note inside the session memory. */
export interface MemoryEntry {
  /** Short key — e.g. "project_type", "key_files", "user_preferences" */
  key: string;
  /** Human-readable value */
  value: string;
  /** Timestamp of last update */
  updatedAt: number;
}

/** Summary of what tools were called and what happened in one iteration. */
export interface IterationSummary {
  iteration: number;
  toolsCalled: string[];
  filesRead: string[];
  filesWritten: string[];
  errorsEncountered: string[];
  keyFindings: string[];
}

export class AgentSessionMemory {
  private entries: Map<string, MemoryEntry> = new Map();
  private iterationHistory: IterationSummary[] = [];
  private userPreferences: string[] = [];
  private originalTask: string = '';

  constructor(
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  /**
   * Record the user's original request so the model never loses sight of
   * what it's supposed to be doing. Called once at the start of a session.
   */
  setOriginalTask(task: string): void {
    this.originalTask = task;
  }

  /** Returns the original task string set at session start. */
  getOriginalTask(): string {
    return this.originalTask;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record what happened in one iteration so the memory can summarize it.
   */
  addIterationSummary(summary: IterationSummary): void {
    this.iterationHistory.push(summary);

    // Auto-extract memory entries from iteration data
    this.autoExtractEntries(summary);
  }

  /** Store or update a named memory entry. */
  set(key: string, value: string): void {
    this.entries.set(key, { key, value, updatedAt: Date.now() });
  }

  /** Retrieve a named entry. */
  get(key: string): string | undefined {
    return this.entries.get(key)?.value;
  }

  /** Record a user preference observed from their messages. */
  addUserPreference(pref: string): void {
    if (!this.userPreferences.includes(pref)) {
      this.userPreferences.push(pref);
    }
  }

  /** How many iterations have been recorded. */
  get iterationCount(): number {
    return this.iterationHistory.length;
  }

  /**
   * Return a one-line compact summary of the session for continuation messages.
   * Returns empty string if nothing interesting has been recorded yet.
   */
  getCompactSummary(): string {
    const parts: string[] = [];
    const allFilesRead = new Set(this.iterationHistory.flatMap(it => it.filesRead));
    const allFilesWritten = new Set(this.iterationHistory.flatMap(it => it.filesWritten));
    const totalErrors = parseInt(this.get('total_errors') || '0', 10);

    if (allFilesRead.size > 0) parts.push(`${allFilesRead.size} files read`);
    if (allFilesWritten.size > 0) parts.push(`${allFilesWritten.size} files written`);
    if (totalErrors > 0) parts.push(`${totalErrors} errors encountered`);
    if (this.userPreferences.length > 0) parts.push(`${this.userPreferences.length} prefs noted`);
    const functionsExplored = this.get('functions_explored');
    if (functionsExplored) {
      const count = functionsExplored.split(', ').length;
      parts.push(`${count} functions explored`);
    }

    return parts.join(', ');
  }

  /** Serialize session memory to JSON for database persistence. */
  toJSON(): string {
    return JSON.stringify({
      entries: Array.from(this.entries.entries()),
      iterationHistory: this.iterationHistory,
      userPreferences: this.userPreferences,
      originalTask: this.originalTask
    });
  }

  /** Restore session memory from persisted JSON. */
  static fromJSON(json: string, outputChannel: vscode.OutputChannel): AgentSessionMemory {
    const memory = new AgentSessionMemory(outputChannel);
    try {
      const data = JSON.parse(json);
      if (data.entries) {
        for (const [key, entry] of data.entries) {
          memory.entries.set(key, entry);
        }
      }
      if (data.iterationHistory) {
        memory.iterationHistory = data.iterationHistory;
      }
      if (data.userPreferences) {
        memory.userPreferences = data.userPreferences;
      }
      if (data.originalTask) {
        memory.originalTask = data.originalTask;
      }
    } catch {
      // If parsing fails, return empty memory
    }
    return memory;
  }

  /**
   * Build a compact text block suitable for injection into the system prompt
   * or as a user-role reminder message.
   */
  toSystemReminder(): string {
    if (this.entries.size === 0 && this.iterationHistory.length === 0) return '';

    const sections: string[] = [];

    // Task reference — abbreviated since the full task is always in the
    // original user message (messages[1]). Only include enough for the model
    // to stay anchored without duplicating the full text.
    if (this.originalTask) {
      const taskPreview = this.originalTask.length > 120
        ? this.originalTask.substring(0, 120) + '…'
        : this.originalTask;
      sections.push(`## Task Reference\n${taskPreview}`);
    }

    // Session notes
    if (this.entries.size > 0) {
      const notes = Array.from(this.entries.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(e => `- **${e.key}**: ${e.value}`)
        .join('\n');
      sections.push(`## Session Notes\n${notes}`);
    }

    // User preferences
    if (this.userPreferences.length > 0) {
      sections.push(`## User Preferences\n${this.userPreferences.map(p => `- ${p}`).join('\n')}`);
    }

    // Recent activity summary (last 3 iterations)
    if (this.iterationHistory.length > 0) {
      const recent = this.iterationHistory.slice(-3);
      const activityLines = recent.map(it => {
        const parts: string[] = [];
        if (it.filesRead.length > 0) parts.push(`read ${it.filesRead.length} files`);
        if (it.filesWritten.length > 0) parts.push(`wrote ${it.filesWritten.join(', ')}`);
        if (it.errorsEncountered.length > 0) parts.push(`${it.errorsEncountered.length} errors`);
        if (it.keyFindings.length > 0) parts.push(it.keyFindings[0]);
        return `- Iter ${it.iteration}: ${parts.join('; ') || 'no significant actions'}`;
      });
      sections.push(`## Recent Activity\n${activityLines.join('\n')}`);
    }

    // Files explored
    const allFilesRead = new Set(this.iterationHistory.flatMap(it => it.filesRead));
    const allFilesWritten = new Set(this.iterationHistory.flatMap(it => it.filesWritten));
    if (allFilesRead.size > 0 || allFilesWritten.size > 0) {
      const fileLines: string[] = [];
      if (allFilesRead.size > 0) {
        const readList = Array.from(allFilesRead).slice(-15);
        fileLines.push(`Files explored: ${readList.join(', ')}${allFilesRead.size > 15 ? ` (+${allFilesRead.size - 15} more)` : ''}`);
      }
      if (allFilesWritten.size > 0) {
        fileLines.push(`Files modified: ${Array.from(allFilesWritten).join(', ')}`);
      }
      sections.push(`## File Tracking\n${fileLines.join('\n')}`);
    }

    return `<session_memory>\n${sections.join('\n\n')}\n</session_memory>`;
  }

  /**
   * Build an IterationSummary from tool call results.
   * This is a convenience method for the executor to call after each iteration.
   */
  static buildIterationSummary(
    iteration: number,
    toolResults: Array<{ name: string; args: any; output: string; success: boolean }>
  ): IterationSummary {
    const summary: IterationSummary = {
      iteration,
      toolsCalled: [],
      filesRead: [],
      filesWritten: [],
      errorsEncountered: [],
      keyFindings: []
    };

    for (const result of toolResults) {
      summary.toolsCalled.push(result.name);

      if (result.name === 'read_file' && result.args?.path) {
        summary.filesRead.push(result.args.path);
      }
      if (result.name === 'write_file' && result.args?.path) {
        summary.filesWritten.push(result.args.path);
      }
      if (!result.success) {
        summary.errorsEncountered.push(`${result.name}: ${result.output.substring(0, 100)}`);
      }

      // Extract key findings from search results
      if (result.name === 'search_workspace' && result.success) {
        const matchCount = (result.output.match(/\n/g) || []).length;
        if (matchCount > 0) {
          summary.keyFindings.push(`Found ${matchCount} matches for "${result.args?.query || 'unknown'}"`);
        }
      }

      // Track code intelligence tool usage for function exploration
      if (['find_definition', 'get_call_hierarchy', 'find_references',
        'find_implementations', 'get_type_hierarchy', 'get_hover_info'].includes(result.name)) {
        const symbolName = result.args?.symbolName || result.args?.symbol || '';
        if (symbolName && result.success) {
          summary.keyFindings.push(`${result.name}: definition of "${symbolName}" found`);
        }
      }
    }

    return summary;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Automatically extract and update memory entries from iteration data.
   */
  private autoExtractEntries(summary: IterationSummary): void {
    // Track project structure discoveries
    if (summary.filesRead.length > 0) {
      const configFiles = summary.filesRead.filter(f =>
        /package\.json|tsconfig|\.eslintrc|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|pom\.xml/i.test(f)
      );
      if (configFiles.length > 0) {
        const existing = this.get('project_config_files') || '';
        const allConfigs = new Set([...existing.split(', ').filter(Boolean), ...configFiles]);
        this.set('project_config_files', Array.from(allConfigs).join(', '));
      }
    }

    // Track error patterns
    if (summary.errorsEncountered.length > 0) {
      const errorCount = parseInt(this.get('total_errors') || '0', 10) + summary.errorsEncountered.length;
      this.set('total_errors', String(errorCount));
    }

    // Track key files written
    if (summary.filesWritten.length > 0) {
      const existing = this.get('files_modified') || '';
      const allWritten = new Set([...existing.split(', ').filter(Boolean), ...summary.filesWritten]);
      this.set('files_modified', Array.from(allWritten).join(', '));
    }

    // Track functions explored via code intelligence tools
    this.autoExtractFunctionsExplored(summary);
  }

  /**
   * Extract function/symbol names from find_definition, get_call_hierarchy,
   * and find_references tool calls and track them in memory.
   */
  private autoExtractFunctionsExplored(summary: IterationSummary): void {
    const symbolTools = ['find_definition', 'get_call_hierarchy', 'find_references',
      'find_implementations', 'get_type_hierarchy', 'get_hover_info'];
    const hasSymbolTools = summary.toolsCalled.some(t => symbolTools.includes(t));
    if (!hasSymbolTools) return;

    // The iteration summary doesn't carry tool args, but we can record the tools used.
    // Detailed function names will be extracted from keyFindings.
    const existing = this.get('functions_explored') || '';
    const existingSet = new Set(existing.split(', ').filter(Boolean));

    // Extract function names from key findings (tool results are captured there)
    for (const finding of summary.keyFindings) {
      // Look for patterns like "Definition of X found" or "call hierarchy for X"
      const defMatch = finding.match(/(?:definition|hierarchy|references|implementations)\s+(?:of|for)\s+['"`]?(\w+)['"`]?/i);
      if (defMatch) {
        existingSet.add(defMatch[1]);
      }
    }

    if (existingSet.size > 0) {
      // Cap at 50 entries to avoid bloat
      const arr = Array.from(existingSet).slice(-50);
      this.set('functions_explored', arr.join(', '));
    }
  }
}
