import { recalcBlockTotals } from './messageHandlers/filesChanged';
import { filesChangedBlocks, tokenUsage } from './state';
import type {
    AssistantThreadFilesChangedBlock,
    AssistantThreadItem,
    AssistantThreadThinkingGroupBlock,
    AssistantThreadToolsBlock,
    CommandApprovalItem,
    FileEditApprovalItem,
    ProgressItem,
    TimelineItem
} from './types';

// ---------------------------------------------------------------------------
// TimelineBuilder — rebuilds the timeline from persisted messages.
// Each UI event type is handled by a dedicated method for readability.
// ---------------------------------------------------------------------------

class TimelineBuilder {
  private items: TimelineItem[] = [];
  private restoredFcBlocks: AssistantThreadFilesChangedBlock[] = [];
  private currentThread: AssistantThreadItem | null = null;
  private currentGroup: ProgressItem | null = null;
  /** Stack of parent progress groups — pushed when a nested group starts, popped on finish */
  private groupStack: ProgressItem[] = [];

  /**
   * The active thinking group being built during history reconstruction.
   * Mirrors `activeThinkingGroup` in live streaming state but is local
   * to the builder instance.
   */
  private currentThinkingGroup: AssistantThreadThinkingGroupBlock | null = null;

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------

  build(messages: any[]): TimelineItem[] {
    for (const m of messages) {
      this.processMessage(m);
    }
    // Close any open thinking group at end of build
    this.closeThinkingGroup();
    filesChangedBlocks.value = this.restoredFcBlocks;
    return this.items;
  }

  // -----------------------------------------------------------------------
  // Message-level dispatch
  // -----------------------------------------------------------------------

  private processMessage(m: any): void {
    if (m.role === 'user') { this.handleUserMessage(m); return; }
    if (m.role === 'assistant') { this.handleAssistantMessage(m); return; }
    if (m.role === 'tool') { this.handleToolMessage(m); }
  }

  private handleUserMessage(m: any): void {
    this.closeThinkingGroup();
    this.items.push({
      id: m.id || `msg_${Date.now()}_${Math.random()}`,
      type: 'message',
      role: 'user',
      content: m.content || '',
      model: m.model
    });
    this.currentThread = null;
    this.currentGroup = null;
  }

  private handleAssistantMessage(m: any): void {
    let content = m.content || '';
    // Backward compat: old sessions persisted `historyContent` which had
    // thinking injected as `[My previous reasoning: ...]\n\n<response>`.
    // The thinking is already displayed via a separate `thinkingBlock` UI
    // event, so strip the prefix to avoid showing it twice.
    content = content.replace(/^\[My previous reasoning: [\s\S]*?\]\n\n/, '');
    this.appendText(content, m.model);
  }

  private handleToolMessage(m: any): void {
    const toolName = m.toolName;
    if (toolName !== '__ui__') return;

    let uiEvent: any = null;
    try {
      uiEvent = JSON.parse(m.toolOutput || m.content || '{}');
    } catch { return; }
    if (!uiEvent?.eventType) return;

    this.dispatchUiEvent(uiEvent, m.id);
  }

  // -----------------------------------------------------------------------
  // UI event dispatch — routes to per-event-type handler methods
  // -----------------------------------------------------------------------

  private dispatchUiEvent(uiEvent: any, messageId: string): void {
    const { eventType } = uiEvent;
    const payload = uiEvent.payload || {};

    // thinkingBlock is thread-level, not a tools-block item
    if (eventType === 'thinkingBlock') {
      this.handleThinkingBlock(payload);
      return;
    }

    switch (eventType) {
      case 'startProgressGroup': this.handleStartProgressGroup(payload, messageId); break;
      case 'showToolAction': this.handleShowToolAction(payload, messageId); break;
      case 'subagentThinking': this.handleSubagentThinking(payload); break;
      case 'finishProgressGroup': this.handleFinishProgressGroup(); break;
      case 'requestToolApproval': this.handleRequestToolApproval(payload, messageId); break;
      case 'toolApprovalResult': this.handleToolApprovalResult(payload, messageId); break;
      case 'requestFileEditApproval': this.handleRequestFileEditApproval(payload, messageId); break;
      case 'fileEditApprovalResult': this.handleFileEditApprovalResult(payload, messageId); break;
      case 'showError': this.handleShowError(payload, messageId); break;
      case 'filesChanged': this.handleFilesChanged(payload); break;
      case 'fileChangeResult': this.handleFileChangeResult(payload); break;
      case 'keepUndoResult': this.handleKeepUndoResult(payload); break;
      case 'contextFiles': this.handleContextFiles(payload); break;
      case 'tokenUsage': this.handleTokenUsage(payload); break;
      default: break;
    }
  }

  // -----------------------------------------------------------------------
  // Thinking group helpers
  // -----------------------------------------------------------------------

  /**
   * Close the active thinking group, if any.
   *
   * The group only contains thinkingContent + tools sections — text content
   * is always placed at thread level (never inside the group).
   * So closing is just: set collapsed, sum durations, null out ref.
   */
  private closeThinkingGroup(): void {
    if (!this.currentThinkingGroup) return;

    this.currentThinkingGroup.streaming = false;
    this.currentThinkingGroup.collapsed = true;
    let total = 0;
    for (const s of this.currentThinkingGroup.sections) {
      if (s.type === 'thinkingContent' && s.durationSeconds) {
        total += s.durationSeconds;
      }
    }
    this.currentThinkingGroup.totalDurationSeconds = total || undefined;
    this.currentThinkingGroup = null;
  }

  /**
   * Get or create a tools block inside the current thinking group's sections.
   * Reuses the last section if it's already a tools block.
   */
  private ensureToolsBlockInGroup(): AssistantThreadToolsBlock {
    const group = this.currentThinkingGroup!;
    const lastSection = group.sections[group.sections.length - 1];
    if (lastSection && lastSection.type === 'tools') {
      return lastSection;
    }
    const block: AssistantThreadToolsBlock = { type: 'tools', tools: [] };
    group.sections.push(block);
    return block;
  }

  /**
   * Resolve the correct tools block: inside the thinking group if active,
   * otherwise at thread level.
   */
  private resolveToolsBlock(): AssistantThreadToolsBlock {
    if (this.currentThinkingGroup) {
      return this.ensureToolsBlockInGroup();
    }
    return this.ensureToolsBlock();
  }

  /**
   * Search all tools blocks in the thread (both thinking group sections and
   * thread-level) for an approval card.
   */
  private findApprovalInAllBlocks(type: string, approvalId: string): CommandApprovalItem | FileEditApprovalItem | undefined {
    const thread = this.ensureThread();
    for (const block of thread.blocks) {
      if (block.type === 'tools') {
        const found = block.tools.find(item => item.type === type && item.id === approvalId);
        if (found) return found as CommandApprovalItem | FileEditApprovalItem;
      }
      if (block.type === 'thinkingGroup') {
        for (const section of block.sections) {
          if (section.type === 'tools') {
            const found = section.tools.find(item => item.type === type && item.id === approvalId);
            if (found) return found as CommandApprovalItem | FileEditApprovalItem;
          }
        }
      }
    }
    return undefined;
  }

  // -----------------------------------------------------------------------
  // Individual UI event handlers
  // -----------------------------------------------------------------------

  private handleThinkingBlock(payload: any): void {
    const thread = this.ensureThread();

    if (this.currentThinkingGroup) {
      // Existing group — add a new thinkingContent section (new thinking round)
      this.currentThinkingGroup.sections.push({
        type: 'thinkingContent',
        content: payload?.content || '',
        durationSeconds: payload?.durationSeconds
      });
    } else {
      // Create a new thinking group
      this.currentThinkingGroup = {
        type: 'thinkingGroup',
        sections: [{
          type: 'thinkingContent',
          content: payload?.content || '',
          durationSeconds: payload?.durationSeconds
        }],
        collapsed: true,
        streaming: false
      };
      thread.blocks.push(this.currentThinkingGroup);
    }
  }

  private handleStartProgressGroup(payload: any, messageId: string): void {
    // Write actions go at thread level — not buried inside the thinking group
    const title = payload?.title || '';
    if (/\b(writ|modif|creat)/i.test(title) && this.currentThinkingGroup) {
      this.closeThinkingGroup();
    }

    // Push current group onto stack so nested sub-agent groups don't clobber parent
    if (this.currentGroup) {
      this.groupStack.push(this.currentGroup);
    }

    const toolsBlock = this.resolveToolsBlock();
    this.currentGroup = {
      id: payload?.groupId || `progress_${messageId}`,
      type: 'progress',
      title: payload?.title || 'Working on task',
      detail: payload?.detail || undefined,
      status: 'running',
      collapsed: false,
      isSubagent: !!payload?.isSubagent,
      actions: []
    };
    toolsBlock.tools.push(this.currentGroup);
  }

  private handleShowToolAction(payload: any, messageId: string): void {
    const toolsBlock = this.resolveToolsBlock();
    if (!this.currentGroup) {
      this.currentGroup = {
        id: `progress_${messageId}`,
        type: 'progress',
        title: 'Working on task',
        status: 'running',
        collapsed: false,
        actions: []
      };
      toolsBlock.tools.push(this.currentGroup);
    }

    const status = payload?.status || 'running';
    const actionText = payload?.text || 'Tool';
    const action = {
      id: `action_${messageId}`,
      status,
      icon: payload?.icon || '•',
      text: actionText,
      detail: payload?.detail || null,
      filePath: payload?.filePath || undefined,
      checkpointId: payload?.checkpointId || undefined,
      startLine: payload?.startLine || undefined
    };

    if (status !== 'running' && status !== 'pending') {
      // Final state (success/error) — update existing running/pending or push
      const existingIndex = this.currentGroup.actions.findIndex(
        a => (a.status === 'running' || a.status === 'pending') && a.text === actionText
      );
      if (existingIndex >= 0) {
        this.currentGroup.actions[existingIndex] = { ...this.currentGroup.actions[existingIndex], ...action };
      } else {
        const lastPendingIndex = [...this.currentGroup.actions].reverse().findIndex(
          a => a.status === 'running' || a.status === 'pending'
        );
        if (lastPendingIndex >= 0) {
          const resolvedIndex = this.currentGroup.actions.length - 1 - lastPendingIndex;
          this.currentGroup.actions[resolvedIndex] = { ...this.currentGroup.actions[resolvedIndex], ...action };
        } else {
          this.currentGroup.actions.push(action);
        }
      }
    } else {
      // Running/pending state — update same-text or push new
      const existingIndex = this.currentGroup.actions.findIndex(
        a => (a.status === 'running' || a.status === 'pending') && a.text === actionText
      );
      if (existingIndex >= 0) {
        this.currentGroup.actions[existingIndex] = { ...this.currentGroup.actions[existingIndex], ...action };
      } else {
        this.currentGroup.actions.push(action);
      }
    }

    if (status === 'error') this.currentGroup.status = 'error';
  }

  /**
   * Insert sub-agent thinking content as an ordered ActionItem in the
   * progress group, so it renders inline at the correct position.
   */
  private handleSubagentThinking(payload: any): void {
    const toolsBlock = this.resolveToolsBlock();
    // Find the last progress group and insert thinking as an action
    for (let i = toolsBlock.tools.length - 1; i >= 0; i--) {
      if (toolsBlock.tools[i].type === 'progress') {
        const group = toolsBlock.tools[i] as ProgressItem;
        group.actions.push({
          id: `thinking_${Date.now()}_${Math.random()}`,
          status: 'success',
          icon: '💭',
          text: payload?.durationSeconds ? `Thought for ${payload.durationSeconds}s` : 'Thought',
          detail: null,
          isThinking: true,
          thinkingContent: payload?.content || '',
          durationSeconds: payload?.durationSeconds
        });
        break;
      }
    }
  }

  private handleFinishProgressGroup(): void {
    if (!this.currentGroup) return;
    this.currentGroup.actions = this.currentGroup.actions.map(action =>
      action.status === 'running' || action.status === 'pending'
        ? { ...action, status: 'success' as const }
        : action
    );
    this.currentGroup.status = this.currentGroup.actions.some(a => a.status === 'error') ? 'error' : 'done';
    // Sub-agent groups stay expanded so thinking content remains visible
    this.currentGroup.collapsed = !this.currentGroup.isSubagent;
    // Restore parent group from the stack (supports nested sub-agent groups)
    this.currentGroup = this.groupStack.pop() || null;
  }

  private handleRequestToolApproval(payload: any, messageId: string): void {
    // Approval cards always go to thread-level tools block (outside thinking group)
    const toolsBlock = this.ensureToolsBlock();
    if (this.currentGroup) {
      this.currentGroup.actions.push({
        id: `action_${payload?.id || messageId}`,
        status: 'running',
        icon: '⚡',
        text: 'Run command',
        detail: 'Awaiting approval'
      });
    }
    toolsBlock.tools.push({
      id: payload?.id || `approval_${messageId}`,
      type: 'commandApproval',
      command: payload?.command || '',
      cwd: payload?.cwd || '',
      severity: payload?.severity || 'medium',
      reason: payload?.reason,
      status: 'pending',
      timestamp: payload?.timestamp || Date.now(),
      output: undefined,
      exitCode: null,
      autoApproved: false
    } as CommandApprovalItem);
  }

  private handleToolApprovalResult(payload: any, messageId: string): void {
    // Update action in progress group
    if (this.currentGroup) {
      const actionId = `action_${payload?.approvalId}`;
      const existingAction = this.currentGroup.actions.find(a => a.id === actionId);
      if (existingAction) {
        if (payload?.status === 'running') {
          existingAction.status = 'running';
        } else {
          const isError = payload?.status === 'skipped' || payload?.status === 'error';
          existingAction.status = isError ? 'error' : 'success';
          existingAction.detail = payload?.command?.substring(0, 60) || existingAction.detail;
          if (isError) this.currentGroup.status = 'error';
        }
      }
    }

    // Find and update existing approval card (search all blocks including groups)
    const approvalId = payload?.approvalId;
    const existing = this.findApprovalInAllBlocks('commandApproval', approvalId) as CommandApprovalItem | undefined;
    if (existing) {
      existing.status = payload?.status || existing.status;
      existing.output = payload?.output ?? existing.output;
      existing.exitCode = payload?.exitCode ?? existing.exitCode;
      if (payload?.command) existing.command = payload.command;
    } else {
      const tb = this.ensureToolsBlock();
      tb.tools.push({
        id: approvalId || `approval_${messageId}`,
        type: 'commandApproval',
        command: payload?.command || '',
        cwd: payload?.cwd || '',
        severity: payload?.severity || 'medium',
        reason: payload?.reason,
        status: payload?.status || 'approved',
        timestamp: Date.now(),
        output: payload?.output,
        exitCode: payload?.exitCode ?? null,
        autoApproved: !!payload?.autoApproved
      } as CommandApprovalItem);
    }
  }

  private handleRequestFileEditApproval(payload: any, messageId: string): void {
    // Approval cards always go to thread-level tools block
    const toolsBlock = this.ensureToolsBlock();
    toolsBlock.tools.push({
      id: payload?.id || `file_approval_${messageId}`,
      type: 'fileEditApproval',
      filePath: payload?.filePath || '',
      severity: payload?.severity || 'medium',
      reason: payload?.reason,
      status: 'pending',
      timestamp: payload?.timestamp || Date.now(),
      diffHtml: payload?.diffHtml,
      autoApproved: false
    } as FileEditApprovalItem);
  }

  private handleFileEditApprovalResult(payload: any, messageId: string): void {
    const approvalId = payload?.approvalId;
    const existing = this.findApprovalInAllBlocks('fileEditApproval', approvalId) as FileEditApprovalItem | undefined;
    if (existing) {
      existing.status = payload?.status || existing.status;
      existing.autoApproved = !!payload?.autoApproved;
    } else {
      const tb = this.ensureToolsBlock();
      tb.tools.push({
        id: approvalId || `file_approval_${messageId}`,
        type: 'fileEditApproval',
        filePath: payload?.filePath || '',
        severity: payload?.severity || 'medium',
        reason: payload?.reason,
        status: payload?.status || 'approved',
        timestamp: Date.now(),
        diffHtml: payload?.diffHtml,
        autoApproved: !!payload?.autoApproved
      } as FileEditApprovalItem);
    }
  }

  /**
   * Attach context file references to the most recent user message.
   * Persisted as a __ui__ event right after the user message.
   */
  private handleContextFiles(payload: any): void {
    const files = payload?.files;
    if (!Array.isArray(files) || files.length === 0) return;

    // Walk backwards to find the last user message
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.type === 'message' && item.role === 'user') {
        item.contextFiles = files;
        break;
      }
    }
  }

  private handleShowError(payload: any, messageId: string): void {
    if (!this.currentGroup) {
      this.currentGroup = {
        id: `progress_${messageId}`,
        type: 'progress',
        title: 'Working on task',
        status: 'running',
        collapsed: false,
        actions: []
      };
      const tb = this.resolveToolsBlock();
      tb.tools.push(this.currentGroup);
    }
    this.currentGroup.actions.push({
      id: `action_${messageId}`,
      status: 'error',
      icon: '✗',
      text: payload?.message || 'Error',
      detail: null
    });
    this.currentGroup.status = 'error';
    this.currentGroup.collapsed = true;
    this.currentGroup = null;
  }

  private handleFilesChanged(payload: any): void {
    const checkpointId = payload.checkpointId || '';
    const isPending = !payload.status || payload.status === 'pending';

    let theBlock = this.restoredFcBlocks.length > 0 ? this.restoredFcBlocks[0] : null;

    if (!theBlock) {
      theBlock = {
        type: 'filesChanged',
        checkpointIds: checkpointId ? [checkpointId] : [],
        files: [],
        totalAdditions: undefined,
        totalDeletions: undefined,
        status: payload.status || 'pending',
        collapsed: !isPending,
        statsLoading: isPending
      };
      this.restoredFcBlocks.push(theBlock);
    } else {
      if (checkpointId && !theBlock.checkpointIds.includes(checkpointId)) {
        theBlock.checkpointIds.push(checkpointId);
      }
      if (isPending) {
        theBlock.collapsed = false;
        theBlock.statsLoading = true;
      }
    }

    for (const f of payload.files || []) {
      if (!theBlock.files.some((ef: any) => ef.path === f.path)) {
        theBlock.files.push({
          path: f.path,
          action: f.action || 'modified',
          additions: undefined,
          deletions: undefined,
          status: payload.status === 'kept' ? 'kept' as const
            : payload.status === 'undone' ? 'undone' as const
            : 'pending' as const,
          checkpointId
        });
      }
    }
  }

  private handleFileChangeResult(payload: any): void {
    if (!payload.success || !payload.checkpointId || this.restoredFcBlocks.length === 0) return;
    const fcBlock = this.restoredFcBlocks[0];
    const idx = fcBlock.files.findIndex((f: any) => f.path === payload.filePath && f.checkpointId === payload.checkpointId);
    if (idx >= 0) fcBlock.files.splice(idx, 1);

    if (!fcBlock.files.some(f => f.checkpointId === payload.checkpointId)) {
      const cidx = fcBlock.checkpointIds.indexOf(payload.checkpointId);
      if (cidx >= 0) fcBlock.checkpointIds.splice(cidx, 1);
    }

    if (fcBlock.files.length === 0) {
      this.restoredFcBlocks.splice(0, 1);
    } else {
      recalcBlockTotals(fcBlock);
    }
  }

  private handleKeepUndoResult(payload: any): void {
    if (!payload.success || !payload.checkpointId || this.restoredFcBlocks.length === 0) return;
    const fcBlock = this.restoredFcBlocks[0];
    fcBlock.files = fcBlock.files.filter(f => f.checkpointId !== payload.checkpointId);
    const cidx = fcBlock.checkpointIds.indexOf(payload.checkpointId);
    if (cidx >= 0) fcBlock.checkpointIds.splice(cidx, 1);

    if (fcBlock.files.length === 0) {
      this.restoredFcBlocks.splice(0, 1);
    } else {
      recalcBlockTotals(fcBlock);
    }
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  private ensureThread(model?: string): AssistantThreadItem {
    if (!this.currentThread) {
      this.currentThread = {
        id: `thread_${Date.now()}_${Math.random()}`,
        type: 'assistantThread',
        role: 'assistant',
        blocks: [{ type: 'text', content: '' }],
        model
      };
      this.items.push(this.currentThread);
    }
    if (model) this.currentThread.model = model;
    return this.currentThread;
  }

  private ensureToolsBlock(): AssistantThreadToolsBlock {
    const thread = this.ensureThread();
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    if (lastBlock && lastBlock.type === 'tools') {
      return lastBlock;
    }
    const newBlock: AssistantThreadToolsBlock = { type: 'tools', tools: [] };
    thread.blocks.push(newBlock);
    return newBlock;
  }

  /**
   * Restore token usage state from a persisted __ui__ tokenUsage event.
   * Each event overwrites the previous — only the last one matters so the
   * pie shows the final token state when reopening a session.
   */
  private handleTokenUsage(payload: any): void {
    tokenUsage.visible = true;
    tokenUsage.promptTokens = payload.promptTokens ?? 0;
    tokenUsage.completionTokens = payload.completionTokens ?? 0;
    tokenUsage.contextWindow = payload.contextWindow ?? 0;
    if (payload.categories) {
      tokenUsage.categories.system = payload.categories.system ?? 0;
      tokenUsage.categories.toolDefinitions = payload.categories.toolDefinitions ?? 0;
      tokenUsage.categories.messages = payload.categories.messages ?? 0;
      tokenUsage.categories.toolResults = payload.categories.toolResults ?? 0;
      tokenUsage.categories.files = payload.categories.files ?? 0;
      tokenUsage.categories.total = payload.categories.total ?? 0;
    }
  }

  private appendText(content: string, model?: string): void {
    if (!content) return;

    // Text content signals the end of a thinking+tools cycle.
    // Close the active thinking group so the next thinkingBlock creates a NEW group.
    // This gives: [group₁: thinking+tools] text₁ [group₂: thinking+tools] text₂
    this.closeThinkingGroup();

    const thread = this.ensureThread(model);
    const lastBlock = thread.blocks[thread.blocks.length - 1];
    // When a thinking group is active, each iteration's text is a separate
    // block (matches live streaming where streamThinking resets the target).
    // For non-thinking models, merge consecutive text blocks.
    if (lastBlock && lastBlock.type === 'text' && !this.currentThinkingGroup) {
      lastBlock.content = lastBlock.content ? `${lastBlock.content}\n\n${content}` : content;
    } else {
      thread.blocks.push({ type: 'text', content });
    }
  }
}

// ---------------------------------------------------------------------------
// Exported function — preserves the original API. Instantiates a fresh
// TimelineBuilder per call for isolation.
// ---------------------------------------------------------------------------

export const buildTimelineFromMessages = (messages: any[]): TimelineItem[] => {
  return new TimelineBuilder().build(messages);
};