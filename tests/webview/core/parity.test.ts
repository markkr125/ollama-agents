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
      if (b.type === 'tools') return {
        type: 'tools',
        tools: b.tools.map((t: any) => {
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
        })
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
    // Just signal done
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
    // [thinking₁(collapsed)] [tools(done)] [thinking₂(collapsed)] [text] [thinking₃(collapsed)]
    expect(liveBlocks.length).toBe(5);
    expect(liveBlocks[0]).toEqual({ type: 'thinking', content: 'Let me check git version.', collapsed: true });
    expect(liveBlocks[1].type).toBe('tools');
    expect(liveBlocks[2]).toEqual({ type: 'thinking', content: 'Now I can answer about git.', collapsed: true });
    expect(liveBlocks[3]).toEqual({
      type: 'text',
      content: 'Git is a distributed VCS.\n\nYou have **Git 2.43.0**.'
    });
    expect(liveBlocks[4]).toEqual({ type: 'thinking', content: 'Task done.', collapsed: true });
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

    // Done
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
    // [thinking₁] [text₁] [tools] [thinking₂] [text₂]
    expect(liveBlocks.length).toBe(5);
    expect(liveBlocks[0].type).toBe('thinking');
    expect(liveBlocks[1]).toEqual({ type: 'text', content: 'I\'ll check the file.' });
    expect(liveBlocks[2].type).toBe('tools');
    expect(liveBlocks[3].type).toBe('thinking');
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

    // [thinking₁] [tools₁] [thinking₂] [tools₂] [text(summary)]
    expect(liveBlocks.length).toBe(5);
    expect(liveBlocks[0]).toEqual({ type: 'thinking', content: 'Planning...', collapsed: true });
    expect(liveBlocks[1].type).toBe('tools');
    expect(liveBlocks[2]).toEqual({ type: 'thinking', content: 'Writing...', collapsed: true });
    expect(liveBlocks[3].type).toBe('tools');
    expect(liveBlocks[4]).toEqual({ type: 'text', content: 'Task completed successfully.' });
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

    // [thinking₁] [tools] [thinking₂] [text]
    expect(liveBlocks.length).toBe(4);
  });
});


describe('CRITICAL: activeStreamBlock prevents duplicate text blocks', () => {
  test('streamChunk after thinking reuses correct text block', async () => {
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
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('Text 1');
  });

  test('multiple streamChunks in same iteration update same block', async () => {
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
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    // All chunks should update the SAME block, not create new ones
    expect(textBlocks.length).toBe(1);
    expect(textBlocks[0].content).toBe('Part one and two');
  });

  test('new thinking block creates new text block for next iteration', async () => {
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
    const textBlocks = thread.blocks.filter((b: any) => b.type === 'text' && b.content);
    // Each iteration should have its OWN text block (not accumulated)
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
});
