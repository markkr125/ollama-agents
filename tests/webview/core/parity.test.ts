/**
 * CRITICAL PARITY TESTS
 *
 * These tests simulate a full agent session through BOTH paths:
 *   1. Live handlers (streaming.ts, progress.ts, sessions.ts)
 *   2. Timeline builder (timelineBuilder.ts)
 *
 * Then verify the resulting block structures are IDENTICAL.
 *
 * This is the single most important test file in the project.
 * If live chat and restored session don't match, the UX is broken.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Helper: create a __ui__ event DB message */
const makeUiEvent = (id: string, eventType: string, payload: any) => ({
  id,
  role: 'tool',
  toolName: '__ui__',
  toolOutput: JSON.stringify({ eventType, payload })
});

/** Helper: normalize a tool item for comparison */
const normalizeToolItem = (t: any) => {
  if (t.type === 'progress') return {
    type: 'progress',
    title: t.title,
    status: t.status,
    collapsed: t.collapsed,
    actionCount: t.actions?.length || 0
  };
  if (t.type === 'commandApproval') return {
    type: 'commandApproval',
    command: t.command,
    status: t.status
  };
  return { type: t.type };
};

/** Helper: normalize a thinking group section */
const normalizeSection = (s: any) => {
  if (s.type === 'thinkingContent') return { type: 'thinkingContent', content: s.content };
  if (s.type === 'text') return { type: 'text', content: s.content };
  if (s.type === 'tools') return {
    type: 'tools',
    tools: s.tools.map(normalizeToolItem)
  };
  return s;
};

/**
 * Normalize blocks for structural comparison.
 * Strips IDs, collapses whitespace, removes empty text blocks.
 */
const normalizeBlocks = (blocks: any[]) =>
  blocks
    .filter((b: any) => !(b.type === 'text' && !b.content))  // Skip empty text blocks
    .map((b: any) => {
      if (b.type === 'text') return { type: 'text', content: b.content };
      if (b.type === 'thinking') return { type: 'thinking', content: b.content, collapsed: b.collapsed };
      if (b.type === 'thinkingGroup') return {
        type: 'thinkingGroup',
        collapsed: b.collapsed,
        sections: b.sections.map(normalizeSection)
      };
      if (b.type === 'tools') return {
        type: 'tools',
        tools: b.tools.map(normalizeToolItem)
      };
      return b;
    });


describe('CRITICAL: Live handlers vs timelineBuilder block-structure parity', () => {

  /**
   * Scenario: Thinking model (3 iterations)
   *   Iter1: thinking + tool call (run_terminal_command) - no text content
   *   Iter2: thinking + text response (answer) - no tools
   *   Iter3: thinking + [TASK_COMPLETE] - no text content
   *
   * This is the EXACT scenario from the bug report screenshots.
   */
  test('thinking model with tool call: live === restored', async () => {
    // ─── PATH 1: Live handlers ───
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');
    const approvals = await import('../../../src/webview/scripts/core/messageHandlers/approvals');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // ── Iteration 1: thinking + tool call, NO text ──
    // Thinking tokens arrive
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Let me check git version.' });
    // No content tokens (model only produced thinking + tool_calls)
    // Collapse thinking
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    // Progress group for tool execution
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Running commands' });
    // Command approval
    approvals.handleRequestToolApproval({
      type: 'requestToolApproval',
      sessionId: undefined,
      approval: {
        id: 'approval_1',
        command: 'git --version',
        cwd: '/project',
        severity: 'medium',
        reason: 'Requires approval',
        status: 'pending',
        timestamp: Date.now()
      }
    });
    // Approval result
    approvals.handleToolApprovalResult({
      type: 'toolApprovalResult',
      approvalId: 'approval_1',
      status: 'approved',
      output: 'git version 2.43.0\nExit code: 0',
      command: 'git --version'
    });
    // Success action
    progress.handleShowToolAction({
      type: 'showToolAction',
      status: 'success',
      icon: '⚡',
      text: 'Command completed',
      detail: 'exit 0'
    });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // ── Iteration 2: thinking + text answer, NO tools ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Now I can answer about git.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    // Per-iteration text (NOT accumulated — just this iteration's delta)
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Git is a distributed VCS.\n\nYou have **Git 2.43.0**.' });

    // ── Iteration 3: thinking + TASK_COMPLETE, NO text ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Task done.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    // No streamChunk (model said [TASK_COMPLETE], no real content)

    // ── Final ──
    // No new content in finalMessage (all text was already persisted per-iteration)
    // Just signal done — close the thinking group (simulates handleGenerationStopped)
    streaming.closeActiveThinkingGroup();
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    streaming.resetActiveStreamBlock();

    const liveThread = state.timeline.value[0] as any;
    const liveBlocks = normalizeBlocks(liveThread.blocks);

    // ─── PATH 2: Timeline builder (from DB messages) ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    // These are the EXACT messages that the executor would persist:
    const dbMessages = [
      // Iter1: thinkingBlock → (no assistant text) → tool events
      makeUiEvent('ui1', 'thinkingBlock', { content: 'Let me check git version.' }),
      makeUiEvent('ui2', 'startProgressGroup', { title: 'Running commands' }),
      makeUiEvent('ui3', 'requestToolApproval', {
        id: 'approval_1',
        command: 'git --version',
        cwd: '/project',
        severity: 'medium',
        reason: 'Requires approval'
      }),
      makeUiEvent('ui4', 'toolApprovalResult', {
        approvalId: 'approval_1',
        status: 'approved',
        output: 'git version 2.43.0\nExit code: 0',
        command: 'git --version'
      }),
      { id: 't1', role: 'tool', toolName: 'run_terminal_command', toolOutput: 'git version 2.43.0' },
      makeUiEvent('ui5', 'showToolAction', {
        status: 'success',
        icon: '⚡',
        text: 'Command completed',
        detail: 'exit 0'
      }),
      makeUiEvent('ui6', 'finishProgressGroup', {}),

      // Iter2: thinkingBlock → assistant delta text
      makeUiEvent('ui7', 'thinkingBlock', { content: 'Now I can answer about git.' }),
      { id: 'a1', role: 'assistant', content: 'Git is a distributed VCS.\n\nYou have **Git 2.43.0**.' },

      // Iter3: thinkingBlock → (no assistant text, was [TASK_COMPLETE])
      makeUiEvent('ui8', 'thinkingBlock', { content: 'Task done.' })
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    const restoredBlocks = normalizeBlocks(restoredThread.blocks);

    // ─── PARITY CHECK ───
    expect(liveBlocks).toEqual(restoredBlocks);

    // Also verify the expected structure explicitly:
    // streamChunk closes group1 (T1+tools+T2), then T3 opens a new group2.
    // [group1{T1,tools,T2}] [tools(approval)] [text(answer)] [group2{T3}]
    expect(liveBlocks.length).toBe(4);
    expect(liveBlocks[0].type).toBe('thinkingGroup');
    expect(liveBlocks[0].collapsed).toBe(true);
    expect(liveBlocks[0].sections.length).toBe(3);
    expect(liveBlocks[0].sections[0]).toEqual({ type: 'thinkingContent', content: 'Let me check git version.' });
    expect(liveBlocks[0].sections[1].type).toBe('tools');
    expect(liveBlocks[0].sections[2]).toEqual({ type: 'thinkingContent', content: 'Now I can answer about git.' });
    expect(liveBlocks[1].type).toBe('tools');
    expect(liveBlocks[2].type).toBe('text');
    expect(liveBlocks[2].content).toBe('Git is a distributed VCS.\n\nYou have **Git 2.43.0**.');
    expect(liveBlocks[3].type).toBe('thinkingGroup');
    expect(liveBlocks[3].collapsed).toBe(true);
    expect(liveBlocks[3].sections.length).toBe(1);
    expect(liveBlocks[3].sections[0]).toEqual({ type: 'thinkingContent', content: 'Task done.' });
  });


  /**
   * Scenario: Thinking model with text in every iteration
   *   Iter1: thinking + text "I'll check" + tool call
   *   Iter2: thinking + text "Here's the answer" + [TASK_COMPLETE]
   */
  test('thinking model with text + tools every iteration: live === restored', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // ── Iter1: thinking + text + tools ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Reasoning step 1' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'I\'ll check the file.' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading files' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read README.md', detail: '10 lines' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // ── Iter2: thinking + text ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Reasoning step 2' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Here is the answer.' });

    // Done — close thinking group (simulates handleGenerationStopped)
    streaming.closeActiveThinkingGroup();
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    streaming.resetActiveStreamBlock();

    const liveBlocks = normalizeBlocks((state.timeline.value[0] as any).blocks);

    // ─── Timeline builder ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');
    const dbMessages = [
      makeUiEvent('ui1', 'thinkingBlock', { content: 'Reasoning step 1' }),
      { id: 'a1', role: 'assistant', content: 'I\'ll check the file.' },
      makeUiEvent('ui2', 'startProgressGroup', { title: 'Reading files' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '📄', text: 'Read README.md', detail: '10 lines' }),
      makeUiEvent('ui4', 'finishProgressGroup', {}),
      makeUiEvent('ui5', 'thinkingBlock', { content: 'Reasoning step 2' }),
      { id: 'a2', role: 'assistant', content: 'Here is the answer.' }
    ];

    const restoredBlocks = normalizeBlocks((builder.buildTimelineFromMessages(dbMessages)[0] as any).blocks);

    expect(liveBlocks).toEqual(restoredBlocks);

    // Verify structure:
    // streamChunk closes the group each time, next thinking opens a new one.
    // [group1{T1}] [text₁] [tools] [group2{T2}] [text₂]
    expect(liveBlocks.length).toBe(5);
    expect(liveBlocks[0].type).toBe('thinkingGroup');
    expect(liveBlocks[0].collapsed).toBe(true);
    expect(liveBlocks[0].sections.length).toBe(1);
    expect(liveBlocks[0].sections[0]).toEqual({ type: 'thinkingContent', content: 'Reasoning step 1' });
    expect(liveBlocks[1]).toEqual({ type: 'text', content: 'I\'ll check the file.' });
    expect(liveBlocks[2].type).toBe('tools');
    expect(liveBlocks[3].type).toBe('thinkingGroup');
    expect(liveBlocks[3].collapsed).toBe(true);
    expect(liveBlocks[3].sections.length).toBe(1);
    expect(liveBlocks[3].sections[0]).toEqual({ type: 'thinkingContent', content: 'Reasoning step 2' });
    expect(liveBlocks[4]).toEqual({ type: 'text', content: 'Here is the answer.' });
  });


  /**
   * Scenario: Non-thinking model (no thinking blocks)
   *   Iter1: text + tools
   *   Iter2: text + [TASK_COMPLETE]
   */
  test('non-thinking model: live === restored', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: text + tools
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Let me read the file.' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading files' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read file', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Iter2: text
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Here is the summary.' });

    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    streaming.resetActiveStreamBlock();

    const liveBlocks = normalizeBlocks((state.timeline.value[0] as any).blocks);

    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');
    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'Let me read the file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Reading files' }),
      makeUiEvent('ui2', 'showToolAction', { status: 'success', icon: '📄', text: 'Read file', detail: '' }),
      makeUiEvent('ui3', 'finishProgressGroup', {}),
      { id: 'a2', role: 'assistant', content: 'Here is the summary.' }
    ];

    const restoredBlocks = normalizeBlocks((builder.buildTimelineFromMessages(dbMessages)[0] as any).blocks);

    expect(liveBlocks).toEqual(restoredBlocks);

    // [text₁] [tools] [text₂]
    expect(liveBlocks.length).toBe(3);
    expect(liveBlocks[0]).toEqual({ type: 'text', content: 'Let me read the file.' });
    expect(liveBlocks[1].type).toBe('tools');
    expect(liveBlocks[2]).toEqual({ type: 'text', content: 'Here is the summary.' });
  });


  /**
   * Scenario: Final message with summary prefix (files modified)
   * The finalMessage carries only the prefix — per-iteration text is already in place.
   */
  test('final message with summary prefix: live === restored', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: text + tools
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'I\'ll create the file.' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Writing files' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '✏️', text: 'Wrote index.ts', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Iter2: text + TASK_COMPLETE
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Done creating the file.' });

    // Final message: only summary prefix
    streaming.handleFinalMessage({ type: 'finalMessage', content: '**1 file modified**' });

    const liveBlocks = normalizeBlocks((state.timeline.value[0] as any).blocks);

    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');
    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'I\'ll create the file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', { status: 'success', icon: '✏️', text: 'Wrote index.ts', detail: '' }),
      makeUiEvent('ui3', 'finishProgressGroup', {}),
      { id: 'a2', role: 'assistant', content: 'Done creating the file.' },
      { id: 'a3', role: 'assistant', content: '**1 file modified**' }
    ];

    const restoredBlocks = normalizeBlocks((builder.buildTimelineFromMessages(dbMessages)[0] as any).blocks);

    expect(liveBlocks).toEqual(restoredBlocks);

    // [text₁] [tools] [text₂ + summary merged]
    expect(liveBlocks.length).toBe(3);
    expect(liveBlocks[0]).toEqual({ type: 'text', content: 'I\'ll create the file.' });
    expect(liveBlocks[1].type).toBe('tools');
    expect(liveBlocks[2]).toEqual({ type: 'text', content: 'Done creating the file.\n\n**1 file modified**' });
  });


  /**
   * Scenario: Thinking model where model only thinks (no content text at all).
   *   Iter1: thinking + tool call
   *   Iter2: thinking + tool call
   *   Final: fallback summary generated
   */
  test('thinking model with no text content: live === restored', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: thinking + tool
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Planning...' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read file', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Iter2: thinking + tool
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Writing...' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Writing' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '✏️', text: 'Wrote file', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Final: fallback summary (no per-iteration text was streamed)
    streaming.handleFinalMessage({ type: 'finalMessage', content: 'Task completed successfully.' });

    const liveBlocks = normalizeBlocks((state.timeline.value[0] as any).blocks);

    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');
    const dbMessages = [
      makeUiEvent('ui1', 'thinkingBlock', { content: 'Planning...' }),
      makeUiEvent('ui2', 'startProgressGroup', { title: 'Reading' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '📄', text: 'Read file', detail: '' }),
      makeUiEvent('ui4', 'finishProgressGroup', {}),
      makeUiEvent('ui5', 'thinkingBlock', { content: 'Writing...' }),
      makeUiEvent('ui6', 'startProgressGroup', { title: 'Writing' }),
      makeUiEvent('ui7', 'showToolAction', { status: 'success', icon: '✏️', text: 'Wrote file', detail: '' }),
      makeUiEvent('ui8', 'finishProgressGroup', {}),
      { id: 'a1', role: 'assistant', content: 'Task completed successfully.' }
    ];

    const restoredBlocks = normalizeBlocks((builder.buildTimelineFromMessages(dbMessages)[0] as any).blocks);

    expect(liveBlocks).toEqual(restoredBlocks);

    // Write group is pulled out of the thinking group:
    // [thinkingGroup{thinking₁, tools₁, thinking₂}] [tools₂(write)] [text(summary)]
    expect(liveBlocks.length).toBe(3);
    expect(liveBlocks[0].type).toBe('thinkingGroup');
    expect(liveBlocks[0].collapsed).toBe(true);
    expect(liveBlocks[0].sections.length).toBe(3);
    expect(liveBlocks[0].sections[0]).toEqual({ type: 'thinkingContent', content: 'Planning...' });
    expect(liveBlocks[0].sections[1].type).toBe('tools');
    expect(liveBlocks[0].sections[2]).toEqual({ type: 'thinkingContent', content: 'Writing...' });
    expect(liveBlocks[1].type).toBe('tools');
    expect(liveBlocks[2]).toEqual({ type: 'text', content: 'Task completed successfully.' });
  });


  /**
   * Scenario: Multiple tool calls per iteration with thinking
   *   Iter1: thinking + 2 tool calls in same progress group
   *   Iter2: thinking + text + TASK_COMPLETE
   */
  test('multiple tools per iteration with thinking: live === restored', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: thinking + 2 tools
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Need to read two files.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading files' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read package.json', detail: '' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read tsconfig.json', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Iter2: thinking + text
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Got both files.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Both files look good.' });

    // Close thinking group (simulates handleGenerationStopped)
    streaming.closeActiveThinkingGroup();
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    streaming.resetActiveStreamBlock();

    const liveBlocks = normalizeBlocks((state.timeline.value[0] as any).blocks);

    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');
    const dbMessages = [
      makeUiEvent('ui1', 'thinkingBlock', { content: 'Need to read two files.' }),
      makeUiEvent('ui2', 'startProgressGroup', { title: 'Reading files' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '📄', text: 'Read package.json', detail: '' }),
      makeUiEvent('ui4', 'showToolAction', { status: 'success', icon: '📄', text: 'Read tsconfig.json', detail: '' }),
      makeUiEvent('ui5', 'finishProgressGroup', {}),
      makeUiEvent('ui6', 'thinkingBlock', { content: 'Got both files.' }),
      { id: 'a1', role: 'assistant', content: 'Both files look good.' }
    ];

    const restoredBlocks = normalizeBlocks((builder.buildTimelineFromMessages(dbMessages)[0] as any).blocks);

    expect(liveBlocks).toEqual(restoredBlocks);

    // [thinkingGroup{thinking₁, tools, thinking₂}] [text]
    // text is extracted from the group on close (it's the final answer)
    expect(liveBlocks.length).toBe(2);
    expect(liveBlocks[0].type).toBe('thinkingGroup');
    expect(liveBlocks[0].collapsed).toBe(true);
    expect(liveBlocks[0].sections.length).toBe(3);
    expect(liveBlocks[1]).toEqual({ type: 'text', content: 'Both files look good.' });
  });
});


describe('CRITICAL: activeStreamBlock prevents duplicate text blocks', () => {
  test('streamChunk after thinking creates text block at thread level (not inside group)', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // Iter1: thinking → text
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Thinking 1' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Text 1' });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks.find((b: any) => b.type === 'thinkingGroup');
    expect(group).toBeDefined();
    // Text goes at thread level, NOT inside group
    const textSections = group.sections.filter((s: any) => s.type === 'text');
    expect(textSections.length).toBe(0);
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('Text 1');
  });

  test('multiple streamChunks in same iteration update same thread-level text block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Thinking' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });

    // Multiple chunks in same iteration (from throttled streaming)
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Part' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Part one' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Part one and two' });

    const thread = state.timeline.value[0] as any;
    // All chunks update the SAME thread-level text block
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('Part one and two');
  });

  test('new thinking block after text does not merge text into group', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // Iter1
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'T1' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Text iter1' });

    // Iter2
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'T2' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Text iter2' });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks.find((b: any) => b.type === 'thinkingGroup');
    // Group should only have thinking content, no text
    const textInGroup = group.sections.filter((s: any) => s.type === 'text');
    expect(textInGroup.length).toBe(0);
    // Both texts at thread level
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(2);
    expect(textBlocks[0].content).toBe('Text iter1');
    expect(textBlocks[1].content).toBe('Text iter2');
  });

  test('non-thinking model still creates per-iteration text blocks after tools', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: text + tools
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Checking...' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Iter2: text (activeStreamBlock was pointing to iter1's block, but tools were added after it)
    // The new streamChunk should detect that activeStreamBlock is BEFORE the tools block
    // and create a new block after the tools
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Result.' });

    const thread = state.timeline.value[0] as any;
    const nonEmptyTexts = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(nonEmptyTexts.length).toBe(2);
    expect(nonEmptyTexts[0].content).toBe('Checking...');
    expect(nonEmptyTexts[1].content).toBe('Result.');
  });
});


/**
 * Text content ALWAYS goes at thread-level, never inside a thinking group.
 * These tests verify the key scenarios around text + thinking group interaction.
 */
describe('Text is always outside thinking group', () => {
  /**
   * Exact scenario from screenshot:
   *   Iter1: thinking + tool (list files)
   *   Iter2: thinking + tool (read file)
   *   Iter3: thinking + FINAL ANSWER TEXT
   * The answer text must be a thread-level text block, NOT inside the group.
   */
  test('thinking + tools + thinking + tools + thinking + text: text is outside group', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // ── Iter1: thinking + tool ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Let me explore the workspace.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Exploring workspace' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📁', text: 'Listed files', detail: '12 files' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // ── Iter2: thinking + tool ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Need to read the file.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading _sessions.scss' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read _sessions.scss', detail: '200 lines' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // ── Iter3: thinking + FINAL ANSWER TEXT (no tool calls) ──
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Now I can explain the file.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: '_sessions.scss is a **SCSS file** that styles the Sessions page.' });

    // During streaming, text is at thread level (group is still open for more thinking/tools)
    const threadDuring = state.timeline.value[0] as any;
    const groupDuring = threadDuring.blocks.find((b: any) => b.type === 'thinkingGroup');
    const textInGroupDuring = groupDuring.sections.filter((s: any) => s.type === 'text');
    expect(textInGroupDuring.length).toBe(0); // text is NEVER inside the group

    const textBlocksDuring = threadDuring.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocksDuring.length).toBe(1); // text is at thread level

    // Close the group (simulates handleGenerationStopped / handleFinalMessage)
    streaming.closeActiveThinkingGroup();

    const thread = state.timeline.value[0] as any;

    // ── KEY ASSERTION: final answer must be a thread-level text block ──
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('_sessions.scss is a **SCSS file** that styles the Sessions page.');

    // ── The thinking group must NOT contain any text sections ──
    const group = thread.blocks.find((b: any) => b.type === 'thinkingGroup');
    expect(group).toBeDefined();
    expect(group.collapsed).toBe(true);
    const textInGroup = group.sections.filter((s: any) => s.type === 'text');
    expect(textInGroup.length).toBe(0);

    // Group should have: thinking₁ + tools₁ + thinking₂ + tools₂ + thinking₃
    expect(group.sections.length).toBe(5);
    expect(group.sections[0].type).toBe('thinkingContent');
    expect(group.sections[1].type).toBe('tools');
    expect(group.sections[2].type).toBe('thinkingContent');
    expect(group.sections[3].type).toBe('tools');
    expect(group.sections[4].type).toBe('thinkingContent');
  });

  /** Same scenario via timelineBuilder (history restoration). */
  test('same scenario from DB: text is outside group (parity)', async () => {
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');
    const normalizeSection = (s: any) => {
      if (s.type === 'thinkingContent') return { type: 'thinkingContent' };
      if (s.type === 'text') return { type: 'text', content: s.content };
      if (s.type === 'tools') return { type: 'tools' };
      return s;
    };

    const dbMessages = [
      makeUiEvent('ui1', 'thinkingBlock', { content: 'Let me explore the workspace.' }),
      makeUiEvent('ui2', 'startProgressGroup', { title: 'Exploring workspace' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '📁', text: 'Listed files', detail: '12 files' }),
      makeUiEvent('ui4', 'finishProgressGroup', {}),
      makeUiEvent('ui5', 'thinkingBlock', { content: 'Need to read the file.' }),
      makeUiEvent('ui6', 'startProgressGroup', { title: 'Reading _sessions.scss' }),
      makeUiEvent('ui7', 'showToolAction', { status: 'success', icon: '📄', text: 'Read _sessions.scss', detail: '200 lines' }),
      makeUiEvent('ui8', 'finishProgressGroup', {}),
      makeUiEvent('ui9', 'thinkingBlock', { content: 'Now I can explain the file.' }),
      { id: 'a1', role: 'assistant', content: '_sessions.scss is a **SCSS file** that styles the Sessions page.' }
    ];

    const timeline = builder.buildTimelineFromMessages(dbMessages);
    const thread = timeline[0] as any;

    // ── KEY ASSERTION: final answer must be a thread-level text block ──
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('_sessions.scss is a **SCSS file** that styles the Sessions page.');

    // Group should NOT contain text sections
    const group = thread.blocks.find((b: any) => b.type === 'thinkingGroup');
    expect(group).toBeDefined();
    expect(group.collapsed).toBe(true);
    const textInGroup = group.sections.filter((s: any) => s.type === 'text');
    expect(textInGroup.length).toBe(0);

    // Group structure: thinking₁ + tools₁ + thinking₂ + tools₂ + thinking₃
    expect(group.sections.map(normalizeSection)).toEqual([
      { type: 'thinkingContent' },
      { type: 'tools' },
      { type: 'thinkingContent' },
      { type: 'tools' },
      { type: 'thinkingContent' }
    ]);
  });

  /** Iteration text (even when followed by tools) goes to thread level. */
  test('iteration text followed by tools goes to thread level', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: thinking + text + tools
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Let me check.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Checking the file...' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read file', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Close group
    streaming.closeActiveThinkingGroup();

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks.find((b: any) => b.type === 'thinkingGroup');

    // Text NEVER goes inside the group
    const textInGroup = group.sections.filter((s: any) => s.type === 'text');
    expect(textInGroup.length).toBe(0);

    // Text is at thread level
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('Checking the file...');
  });

  /**
   * BUG SCENARIO: The model produces the answer in iteration N, then the
   * executor sends "Continue..." and iteration N+1 has thinking + [TASK_COMPLETE].
   * The final thinkingContent section ends up AFTER the text section, so the
   * old "check last section" extraction missed the answer text entirely.
   */
  test('text followed by trailing thinkingContent: text is extracted (live)', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Iter1: thinking + tool
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Let me search.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Searching' });
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '🔍', text: 'Searched', detail: '' });
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    // Iter2: thinking + ANSWER TEXT (no tools → executor sends "Continue...")
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Now I can answer.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'The answer is 42.' });

    // Iter3: thinking for [TASK_COMPLETE] response (no text emitted)
    streaming.handleStreamThinking({ type: 'streamThinking', content: 'Task complete.' });
    streaming.handleCollapseThinking({ type: 'collapseThinking' });
    // No streamChunk — model only said [TASK_COMPLETE]

    // Close group (simulates handleGenerationStopped)
    streaming.closeActiveThinkingGroup();

    const thread = state.timeline.value[0] as any;

    // Answer text must be at thread level
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('The answer is 42.');

    // Group1 must NOT contain text — only T1 + tools + T2
    const groups = thread.blocks.filter((b: any) => b.type === 'thinkingGroup');
    expect(groups.length).toBe(2);

    // Group1: thinking₁ + tools₁ + thinking₂ (closed when streamChunk arrived)
    expect(groups[0].collapsed).toBe(true);
    expect(groups[0].sections.length).toBe(3);
    expect(groups[0].sections[0].type).toBe('thinkingContent');
    expect(groups[0].sections[1].type).toBe('tools');
    expect(groups[0].sections[2].type).toBe('thinkingContent');

    // Group2: thinking₃ only (opened by streamThinking after text)
    expect(groups[1].collapsed).toBe(true);
    expect(groups[1].sections.length).toBe(1);
    expect(groups[1].sections[0].type).toBe('thinkingContent');
  });

  /** Same trailing-thinkingContent scenario via timelineBuilder (history). */
  test('text followed by trailing thinkingContent: text is extracted (history)', async () => {
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      makeUiEvent('ui1', 'thinkingBlock', { content: 'Let me search.' }),
      makeUiEvent('ui2', 'startProgressGroup', { title: 'Searching' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '🔍', text: 'Searched', detail: '' }),
      makeUiEvent('ui4', 'finishProgressGroup', {}),
      makeUiEvent('ui5', 'thinkingBlock', { content: 'Now I can answer.' }),
      { id: 'a1', role: 'assistant', content: 'The answer is 42.' },
      makeUiEvent('ui6', 'thinkingBlock', { content: 'Task complete.' }),
    ];

    const timeline = builder.buildTimelineFromMessages(dbMessages);
    const thread = timeline[0] as any;

    // Answer text must be at thread level
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('The answer is 42.');

    // Two separate groups — group1 closed when text arrived, group2 opened for T3
    const groups = thread.blocks.filter((b: any) => b.type === 'thinkingGroup');
    expect(groups.length).toBe(2);

    // Group1: thinking₁ + tools + thinking₂
    expect(groups[0].sections.length).toBe(3);
    expect(groups[0].sections[0].type).toBe('thinkingContent');
    expect(groups[0].sections[1].type).toBe('tools');
    expect(groups[0].sections[2].type).toBe('thinkingContent');

    // Group2: thinking₃
    expect(groups[1].sections.length).toBe(1);
    expect(groups[1].sections[0].type).toBe('thinkingContent');
  });
});

describe('CRITICAL: Chunked read_file parity - startLine + filePath passthrough', () => {
  /**
   * Scenario: Agent reads a file that gets chunked into 2 chunks.
   * The progress group should contain both chunk actions with startLine,
   * and the structure must match between live and history.
   */
  test('chunked read_file with startLine: live === restored', async () => {
    // ─── PATH 1: Live handlers ───
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Agent streams initial text
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Let me read that file.' });

    // Progress group for chunked read
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading main.ts' });

    // Chunk 1: running then success
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '📄',
      text: 'Reading main.ts', detail: 'lines 1–100',
      filePath: 'src/main.ts', startLine: 1
    });
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '📄',
      text: 'Read main.ts', detail: 'lines 1–100',
      filePath: 'src/main.ts', startLine: 1
    });

    // Chunk 2: running then success
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '📄',
      text: 'Reading main.ts', detail: 'lines 101–150',
      filePath: 'src/main.ts', startLine: 101
    });
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '📄',
      text: 'Read main.ts', detail: 'lines 101–150',
      filePath: 'src/main.ts', startLine: 101
    });

    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const liveThread = state.timeline.value[0] as any;
    const liveToolsBlock = liveThread.blocks.find((b: any) => b.type === 'tools');
    const liveGroup = liveToolsBlock.tools[0];

    // Verify live structure
    expect(liveGroup.title).toBe('Reading main.ts');
    expect(liveGroup.status).toBe('done');
    expect(liveGroup.actions.length).toBe(2);
    expect(liveGroup.actions[0].startLine).toBe(1);
    expect(liveGroup.actions[0].filePath).toBe('src/main.ts');
    expect(liveGroup.actions[0].status).toBe('success');
    expect(liveGroup.actions[0].checkpointId).toBeUndefined();
    expect(liveGroup.actions[1].startLine).toBe(101);
    expect(liveGroup.actions[1].filePath).toBe('src/main.ts');

    // ─── PATH 2: Timeline builder (from DB messages) ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'Let me read that file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Reading main.ts' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'success', icon: '📄', text: 'Read main.ts',
        detail: 'lines 1–100', filePath: 'src/main.ts', startLine: 1
      }),
      makeUiEvent('ui3', 'showToolAction', {
        status: 'success', icon: '📄', text: 'Read main.ts',
        detail: 'lines 101–150', filePath: 'src/main.ts', startLine: 101
      }),
      { id: 't1', role: 'tool', toolName: 'read_file', toolOutput: '...file content...' },
      makeUiEvent('ui4', 'finishProgressGroup', {})
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    const restoredToolsBlock = restoredThread.blocks.find((b: any) => b.type === 'tools');
    const restoredGroup = restoredToolsBlock.tools[0];

    // ─── PARITY CHECK ───
    // Both should have 2 actions with startLine, filePath, no checkpointId
    expect(restoredGroup.actions.length).toBe(liveGroup.actions.length);
    expect(restoredGroup.actions[0].startLine).toBe(liveGroup.actions[0].startLine);
    expect(restoredGroup.actions[0].filePath).toBe(liveGroup.actions[0].filePath);
    expect(restoredGroup.actions[0].checkpointId).toBeUndefined();
    expect(restoredGroup.actions[1].startLine).toBe(liveGroup.actions[1].startLine);
    expect(restoredGroup.actions[1].filePath).toBe(liveGroup.actions[1].filePath);
    expect(restoredGroup.status).toBe(liveGroup.status);
    expect(restoredGroup.title).toBe(liveGroup.title);
  });

  /**
   * REGRESSION: File write actions must produce exactly ONE action entry.
   *
   * Bug: agentFileEditHandler emitted a running action AND then the approval
   * branches also emitted running actions, causing 2+ entries in the
   * progress group. This test verifies:
   *   - ONE running action (from handler) upgrades to ONE success action
   *   - No duplicate action lines for the same file
   *   - Live and restored views show identical action count
   */
  test('REGRESSION: write_file produces exactly one action: live === restored', async () => {
    // ─── PATH 1: Live handlers ───
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    // Agent streams initial text
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'I will create the file.' });

    // Progress group for file write
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Writing files' });

    // Handler emits ONE running action (Creating verb)
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '✏️',
      text: 'Creating utils.ts', detail: ''
    });

    // Tool runner emits success action
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '✏️',
      text: 'Created utils.ts', detail: '+42',
      filePath: 'src/utils.ts', checkpointId: 'cp1'
    });

    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const liveThread = state.timeline.value[0] as any;
    const liveToolsBlock = liveThread.blocks.find((b: any) => b.type === 'tools');
    const liveGroup = liveToolsBlock.tools[0];

    // CRITICAL: Exactly ONE action (running was upgraded to success)
    expect(liveGroup.title).toBe('Writing files');
    expect(liveGroup.status).toBe('done');
    expect(liveGroup.actions.length).toBe(1);
    expect(liveGroup.actions[0].status).toBe('success');
    expect(liveGroup.actions[0].text).toBe('Created utils.ts');
    expect(liveGroup.actions[0].filePath).toBe('src/utils.ts');
    expect(liveGroup.actions[0].checkpointId).toBe('cp1');

    // ─── PATH 2: Timeline builder (from DB messages) ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'I will create the file.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'running', icon: '✏️', text: 'Creating utils.ts', detail: ''
      }),
      makeUiEvent('ui3', 'showToolAction', {
        status: 'success', icon: '✏️', text: 'Created utils.ts', detail: '+42',
        filePath: 'src/utils.ts', checkpointId: 'cp1'
      }),
      { id: 't1', role: 'tool', toolName: 'write_file', toolOutput: 'File written' },
      makeUiEvent('ui4', 'finishProgressGroup', {})
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    const restoredToolsBlock = restoredThread.blocks.find((b: any) => b.type === 'tools');
    const restoredGroup = restoredToolsBlock.tools[0];

    // ─── PARITY CHECK ───
    expect(restoredGroup.actions.length).toBe(liveGroup.actions.length);
    expect(restoredGroup.actions.length).toBe(1);
    expect(restoredGroup.actions[0].status).toBe('success');
    expect(restoredGroup.actions[0].text).toBe('Created utils.ts');
    expect(restoredGroup.actions[0].filePath).toBe('src/utils.ts');
    expect(restoredGroup.actions[0].checkpointId).toBe('cp1');
    expect(restoredGroup.status).toBe(liveGroup.status);
    expect(restoredGroup.title).toBe(liveGroup.title);
  });

  /**
   * REGRESSION: Editing an existing file uses "Editing" → "Edited" verbs.
   *
   * The handler sets _isNew based on whether original content exists.
   * The running action text must use "Editing file" (not "Write file"),
   * and the success action must use "Edited file" (not "Added file").
   */
  test('REGRESSION: edit of existing file uses correct verbs: live === restored', async () => {
    // ─── PATH 1: Live handlers ───
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Updating the config.' });

    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Writing files' });

    // Handler emits Editing (not Write)
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '✏️',
      text: 'Editing config.ts', detail: ''
    });

    // Success with Edited (not Added)
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '✏️',
      text: 'Edited config.ts', detail: '+10 -3',
      filePath: 'src/config.ts', checkpointId: 'cp2'
    });

    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const liveThread = state.timeline.value[0] as any;
    const liveToolsBlock = liveThread.blocks.find((b: any) => b.type === 'tools');
    const liveGroup = liveToolsBlock.tools[0];

    expect(liveGroup.actions.length).toBe(1);
    expect(liveGroup.actions[0].text).toBe('Edited config.ts');
    expect(liveGroup.actions[0].detail).toBe('+10 -3');

    // ─── PATH 2: Timeline builder ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'Updating the config.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'running', icon: '✏️', text: 'Editing config.ts', detail: ''
      }),
      makeUiEvent('ui3', 'showToolAction', {
        status: 'success', icon: '✏️', text: 'Edited config.ts', detail: '+10 -3',
        filePath: 'src/config.ts', checkpointId: 'cp2'
      }),
      { id: 't1', role: 'tool', toolName: 'write_file', toolOutput: 'Written' },
      makeUiEvent('ui4', 'finishProgressGroup', {})
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    const restoredToolsBlock = restoredThread.blocks.find((b: any) => b.type === 'tools');
    const restoredGroup = restoredToolsBlock.tools[0];

    expect(restoredGroup.actions.length).toBe(1);
    expect(restoredGroup.actions[0].text).toBe('Edited config.ts');
    expect(restoredGroup.actions[0].detail).toBe('+10 -3');
    expect(restoredGroup.status).toBe(liveGroup.status);
  });

  /**
   * REGRESSION: Multiple file writes must produce one action per file.
   *
   * When the agent writes 3 files, the progress group must contain
   * exactly 3 action entries (one per file), not 6 (with duplicates).
   */
  test('REGRESSION: multi-file write batch: one action per file, no duplicates', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;

    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Creating three files.' });

    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Writing files' });

    // File 1: running → success
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '✏️',
      text: 'Creating a.ts', detail: ''
    });
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '✏️',
      text: 'Created a.ts', detail: '+20',
      filePath: 'src/a.ts', checkpointId: 'cp1'
    });

    // File 2: running → success
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '✏️',
      text: 'Editing b.ts', detail: ''
    });
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '✏️',
      text: 'Edited b.ts', detail: '+5 -2',
      filePath: 'src/b.ts', checkpointId: 'cp1'
    });

    // File 3: running → success
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '✏️',
      text: 'Creating c.ts', detail: ''
    });
    progress.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '✏️',
      text: 'Created c.ts', detail: '+35',
      filePath: 'src/c.ts', checkpointId: 'cp1'
    });

    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const liveThread = state.timeline.value[0] as any;
    const liveToolsBlock = liveThread.blocks.find((b: any) => b.type === 'tools');
    const liveGroup = liveToolsBlock.tools[0];

    // CRITICAL: Exactly 3 actions (one per file), not 6
    expect(liveGroup.actions.length).toBe(3);
    expect(liveGroup.actions[0].text).toBe('Created a.ts');
    expect(liveGroup.actions[1].text).toBe('Edited b.ts');
    expect(liveGroup.actions[2].text).toBe('Created c.ts');
    expect(liveGroup.status).toBe('done');

    // Verify restored
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'Creating three files.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', { status: 'running', icon: '✏️', text: 'Creating a.ts', detail: '' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '✏️', text: 'Created a.ts', detail: '+20', filePath: 'src/a.ts', checkpointId: 'cp1' }),
      { id: 't1', role: 'tool', toolName: 'write_file', toolOutput: 'Written' },
      makeUiEvent('ui4', 'showToolAction', { status: 'running', icon: '✏️', text: 'Editing b.ts', detail: '' }),
      makeUiEvent('ui5', 'showToolAction', { status: 'success', icon: '✏️', text: 'Edited b.ts', detail: '+5 -2', filePath: 'src/b.ts', checkpointId: 'cp1' }),
      { id: 't2', role: 'tool', toolName: 'write_file', toolOutput: 'Written' },
      makeUiEvent('ui6', 'showToolAction', { status: 'running', icon: '✏️', text: 'Creating c.ts', detail: '' }),
      makeUiEvent('ui7', 'showToolAction', { status: 'success', icon: '✏️', text: 'Created c.ts', detail: '+35', filePath: 'src/c.ts', checkpointId: 'cp1' }),
      { id: 't3', role: 'tool', toolName: 'write_file', toolOutput: 'Written' },
      makeUiEvent('ui8', 'finishProgressGroup', {})
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    const restoredToolsBlock = restoredThread.blocks.find((b: any) => b.type === 'tools');
    const restoredGroup = restoredToolsBlock.tools[0];

    expect(restoredGroup.actions.length).toBe(3);
    expect(restoredGroup.actions[0].text).toBe('Created a.ts');
    expect(restoredGroup.actions[1].text).toBe('Edited b.ts');
    expect(restoredGroup.actions[2].text).toBe('Created c.ts');
    expect(restoredGroup.status).toBe(liveGroup.status);
  });
});

// =============================================================================
// REGRESSION: Sub-agent progress groups — live must match history
// =============================================================================
// Before fix: FilteredAgentEventEmitter blocked startProgressGroup and
// finishProgressGroup from reaching the webview. The live UI showed all
// sub-agent actions under a fallback "Working on task" group. History
// restoration correctly created separate "Sub-agent: [title]" groups because
// timelineBuilder reads ALL persisted events. This caused a CRITICAL
// live vs history mismatch — the #1 worst bug in the system.

describe('CRITICAL: Sub-agent progress groups — live vs history parity', () => {

  test('REGRESSION: sub-agent gets its own progress group with correct title (not "Working on task")', async () => {
    // ─── PATH 1: Live handlers ───
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;
    (state as any).progressIndexStack.value = [];

    // Simulate: assistant text → sub-agent group → tool action → group finish
    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Let me analyze the code.' });

    // Sub-agent wrapper group
    progress.handleStartProgressGroup({
      type: 'startProgressGroup',
      title: 'Sub-agent: Analyze SearchController',
      isSubagent: true
    } as any);

    // Description action inside the group
    progress.handleShowToolAction({
      type: 'showToolAction',
      status: 'running',
      icon: '📋',
      text: 'Examine the search function in SearchController.ts'
    } as any);

    // Tool action
    progress.handleShowToolAction({
      type: 'showToolAction',
      status: 'success',
      icon: '📄',
      text: 'Read SearchController.ts  272 lines'
    } as any);

    // Close sub-agent group
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' } as any);

    const liveThread = state.timeline.value[0] as any;
    // Find the progress group
    let liveGroup: any = null;
    for (const block of liveThread.blocks) {
      if (block.type === 'tools') {
        for (const tool of block.tools) {
          if (tool.type === 'progress') {
            liveGroup = tool;
            break;
          }
        }
      }
      if (liveGroup) break;
    }

    // CRITICAL assertions:
    expect(liveGroup).toBeTruthy();
    expect(liveGroup.title).toBe('Sub-agent: Analyze SearchController');
    expect(liveGroup.title).not.toBe('Working on task');
    expect(liveGroup.isSubagent).toBe(true);
    expect(liveGroup.status).toBe('done');
    // finishProgressGroup transitions running actions → success
    expect(liveGroup.actions.every((a: any) => a.status === 'success')).toBe(true);

    // ─── PATH 2: Timeline builder (from DB messages) ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'Let me analyze the code.' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Sub-agent: Analyze SearchController', isSubagent: true }),
      makeUiEvent('ui2', 'showToolAction', { status: 'running', icon: '📋', text: 'Examine the search function in SearchController.ts' }),
      makeUiEvent('ui3', 'showToolAction', { status: 'success', icon: '📄', text: 'Read SearchController.ts  272 lines' }),
      makeUiEvent('ui4', 'finishProgressGroup', {}),
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    let restoredGroup: any = null;
    for (const block of restoredThread.blocks) {
      if (block.type === 'tools') {
        for (const tool of block.tools) {
          if (tool.type === 'progress') {
            restoredGroup = tool;
            break;
          }
        }
      }
      if (restoredGroup) break;
    }

    // History MUST match live
    expect(restoredGroup).toBeTruthy();
    expect(restoredGroup.title).toBe(liveGroup.title);
    expect(restoredGroup.isSubagent).toBe(liveGroup.isSubagent);
    expect(restoredGroup.status).toBe(liveGroup.status);
    expect(restoredGroup.actions.length).toBe(liveGroup.actions.length);
  });

  test('REGRESSION: multiple sub-agents get separate groups (not all under one)', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;
    (state as any).progressIndexStack.value = [];

    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Analyzing...' });

    // Sub-agent 1
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Sub-agent: Analyze auth', isSubagent: true } as any);
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read auth.ts  50 lines' } as any);
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' } as any);

    // Sub-agent 2
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Sub-agent: Analyze database', isSubagent: true } as any);
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read db.ts  100 lines' } as any);
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' } as any);

    // Sub-agent 3
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Sub-agent: Analyze API', isSubagent: true } as any);
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read api.ts  200 lines' } as any);
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' } as any);

    const liveThread = state.timeline.value[0] as any;
    const liveGroups: any[] = [];
    for (const block of liveThread.blocks) {
      if (block.type === 'tools') {
        for (const tool of block.tools) {
          if (tool.type === 'progress') liveGroups.push(tool);
        }
      }
    }

    // CRITICAL: must have 3 SEPARATE groups, not 1
    expect(liveGroups.length).toBe(3);
    expect(liveGroups[0].title).toBe('Sub-agent: Analyze auth');
    expect(liveGroups[1].title).toBe('Sub-agent: Analyze database');
    expect(liveGroups[2].title).toBe('Sub-agent: Analyze API');
    // All must be completed
    expect(liveGroups.every((g: any) => g.status === 'done')).toBe(true);

    // ─── Verify history matches ───
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    const dbMessages = [
      { id: 'a1', role: 'assistant', content: 'Analyzing...' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Sub-agent: Analyze auth', isSubagent: true }),
      makeUiEvent('ui2', 'showToolAction', { status: 'success', icon: '📄', text: 'Read auth.ts  50 lines' }),
      makeUiEvent('ui3', 'finishProgressGroup', {}),
      makeUiEvent('ui4', 'startProgressGroup', { title: 'Sub-agent: Analyze database', isSubagent: true }),
      makeUiEvent('ui5', 'showToolAction', { status: 'success', icon: '📄', text: 'Read db.ts  100 lines' }),
      makeUiEvent('ui6', 'finishProgressGroup', {}),
      makeUiEvent('ui7', 'startProgressGroup', { title: 'Sub-agent: Analyze API', isSubagent: true }),
      makeUiEvent('ui8', 'showToolAction', { status: 'success', icon: '📄', text: 'Read api.ts  200 lines' }),
      makeUiEvent('ui9', 'finishProgressGroup', {}),
    ];

    const restoredTimeline = builder.buildTimelineFromMessages(dbMessages);
    const restoredThread = restoredTimeline[0] as any;
    const restoredGroups: any[] = [];
    for (const block of restoredThread.blocks) {
      if (block.type === 'tools') {
        for (const tool of block.tools) {
          if (tool.type === 'progress') restoredGroups.push(tool);
        }
      }
    }

    expect(restoredGroups.length).toBe(liveGroups.length);
    for (let i = 0; i < liveGroups.length; i++) {
      expect(restoredGroups[i].title).toBe(liveGroups[i].title);
      expect(restoredGroups[i].status).toBe(liveGroups[i].status);
      expect(restoredGroups[i].actions.length).toBe(liveGroups[i].actions.length);
    }
  });

  test('REGRESSION: sub-agent group nested inside parent iteration group', async () => {
    // When the model calls run_subagent mixed with other tools, the parent
    // creates a group and sub-agent creates a nested group inside it.
    const state = await import('../../../src/webview/scripts/core/state');
    const streaming = await import('../../../src/webview/scripts/core/messageHandlers/streaming');
    const progress = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;
    state.currentProgressIndex.value = null;
    (state as any).progressIndexStack.value = [];

    streaming.handleStreamChunk({ type: 'streamChunk', content: 'Working...' });

    // Parent iteration group (from agentChatExecutor when mixed tools)
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading files' } as any);
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read main.ts  10 lines' } as any);

    // Sub-agent nested inside parent group
    progress.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Sub-agent: Deep analysis', isSubagent: true } as any);
    progress.handleShowToolAction({ type: 'showToolAction', status: 'success', icon: '📄', text: 'Read helper.ts  50 lines' } as any);
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' } as any);

    // Close parent group
    progress.handleFinishProgressGroup({ type: 'finishProgressGroup' } as any);

    const liveThread = state.timeline.value[0] as any;
    const liveGroups: any[] = [];
    for (const block of liveThread.blocks) {
      if (block.type === 'tools') {
        for (const tool of block.tools) {
          if (tool.type === 'progress') liveGroups.push(tool);
        }
      }
    }

    // Should have 2 groups: parent + sub-agent
    expect(liveGroups.length).toBe(2);
    expect(liveGroups[0].title).toBe('Reading files');
    expect(liveGroups[0].isSubagent).toBeFalsy();
    expect(liveGroups[1].title).toBe('Sub-agent: Deep analysis');
    expect(liveGroups[1].isSubagent).toBe(true);
    expect(liveGroups.every((g: any) => g.status === 'done')).toBe(true);
  });
});
