import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streaming handlers', () => {
  test('handleStreamChunk creates assistant thread with text block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStreamChunk({ type: 'streamChunk', content: 'Hello', model: 'm1' });

    expect(state.timeline.value.length).toBe(1);
    const thread = state.timeline.value[0] as any;
    expect(thread.type).toBe('assistantThread');
    expect(thread.blocks.length).toBe(1);
    expect(thread.blocks[0].type).toBe('text');
    expect(thread.blocks[0].content).toBe('Hello');
    expect(thread.model).toBe('m1');
  });

  test('handleStreamChunk replaces content (backend sends accumulated content)', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // Backend sends accumulated content with each chunk
    handlers.handleStreamChunk({ type: 'streamChunk', content: 'Hello ' });
    handlers.handleStreamChunk({ type: 'streamChunk', content: 'Hello World' });

    const thread = state.timeline.value[0] as any;
    expect(thread.blocks[0].content).toBe('Hello World');
  });
});

describe('progress group handlers', () => {
  test('handleStartProgressGroup creates progress in tools block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Working' });

    expect(state.timeline.value.length).toBe(1);
    const thread = state.timeline.value[0] as any;
    // Live view creates empty text block first, then tools block
    expect(thread.blocks.length).toBe(2);
    expect(thread.blocks[0].type).toBe('text');
    expect(thread.blocks[1].type).toBe('tools');
    expect(thread.blocks[1].tools.length).toBe(1);

    const group = thread.blocks[1].tools[0];
    expect(group.type).toBe('progress');
    expect(group.status).toBe('running');
    expect(group.title).toBe('Working');
  });

  test('handleShowToolAction adds action to current progress group', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Working' });
    handlers.handleShowToolAction({
      type: 'showToolAction',
      text: 'Read file',
      status: 'success',
      icon: '📄',
      detail: '50 lines'
    });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks[1].tools[0];
    expect(group.actions.length).toBe(1);
    expect(group.actions[0].text).toBe('Read file');
    expect(group.actions[0].status).toBe('success');
  });

  test('handleFinishProgressGroup marks group done and collapsed', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Working' });
    handlers.handleShowToolAction({ type: 'showToolAction', text: 'Step 1', status: 'success' });
    handlers.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks[1].tools[0];
    expect(group.status).toBe('done');
    expect(group.collapsed).toBe(true);
    expect(state.currentProgressIndex.value).toBe(null);
  });

  test('error action marks group status as error', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Working' });
    handlers.handleShowToolAction({ type: 'showToolAction', text: 'Failed', status: 'error' });
    handlers.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks[1].tools[0];
    expect(group.status).toBe('error');
  });
});

describe('approval handlers - live/history parity', () => {
  test('handleRequestToolApproval adds action to progress group AND approval card', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const progressHandlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');
    const approvalHandlers = await import('../../../src/webview/scripts/core/messageHandlers/approvals');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // Start a progress group first (like backend does)
    progressHandlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Running commands' });

    // Then request approval
    approvalHandlers.handleRequestToolApproval({
      type: 'requestToolApproval',
      approval: {
        id: 'approval_123',
        command: 'npm install',
        cwd: '/project',
        severity: 'medium',
        reason: 'Requires approval'
      }
    });

    const thread = state.timeline.value[0] as any;
    // blocks[0] is empty text, blocks[1] is tools
    const toolsBlock = thread.blocks[1];

    // Progress group should have action
    const progress = toolsBlock.tools[0];
    expect(progress.type).toBe('progress');
    expect(progress.actions.length).toBe(1);
    expect(progress.actions[0].text).toBe('Run command');
    expect(progress.actions[0].detail).toBe('Awaiting approval');
    expect(progress.actions[0].status).toBe('running');

    // Approval card should exist
    const approval = toolsBlock.tools[1];
    expect(approval.type).toBe('commandApproval');
    expect(approval.id).toBe('approval_123');
    expect(approval.command).toBe('npm install');
    expect(approval.status).toBe('pending');
  });

  test('handleToolApprovalResult updates action in progress group AND approval card', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const progressHandlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');
    const approvalHandlers = await import('../../../src/webview/scripts/core/messageHandlers/approvals');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    progressHandlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Running commands' });
    approvalHandlers.handleRequestToolApproval({
      type: 'requestToolApproval',
      approval: { id: 'approval_123', command: 'npm install', cwd: '/project', severity: 'medium' }
    });

    approvalHandlers.handleToolApprovalResult({
      type: 'toolApprovalResult',
      approvalId: 'approval_123',
      status: 'approved',
      command: 'npm install papaparse',
      output: 'up to date\nExit code: 0',
      exitCode: 0
    });

    const thread = state.timeline.value[0] as any;
    const toolsBlock = thread.blocks[1];

    // Progress group action should be updated
    const progress = toolsBlock.tools[0];
    expect(progress.actions[0].status).toBe('success');
    expect(progress.actions[0].detail).toBe('npm install papaparse');

    // Approval card should be updated
    const approval = toolsBlock.tools[1];
    expect(approval.status).toBe('approved');
    expect(approval.command).toBe('npm install papaparse');
    expect(approval.exitCode).toBe(0);
  });

  test('skipped approval marks action as error', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const progressHandlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');
    const approvalHandlers = await import('../../../src/webview/scripts/core/messageHandlers/approvals');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    progressHandlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Running commands' });
    approvalHandlers.handleRequestToolApproval({
      type: 'requestToolApproval',
      approval: { id: 'approval_123', command: 'rm -rf /', cwd: '/', severity: 'high' }
    });

    approvalHandlers.handleToolApprovalResult({
      type: 'toolApprovalResult',
      approvalId: 'approval_123',
      status: 'skipped',
      output: 'Command skipped by user.'
    });

    const thread = state.timeline.value[0] as any;
    const progress = thread.blocks[1].tools[0];
    const approval = thread.blocks[1].tools[1];

    expect(progress.actions[0].status).toBe('error');
    expect(progress.status).toBe('error');
    expect(approval.status).toBe('skipped');
  });
});

describe('live/history consistency contract', () => {
  test('complete workflow produces same structure as timelineBuilder', async () => {
    // This test verifies that the live message handlers produce
    // the same structure as buildTimelineFromMessages

    const state = await import('../../../src/webview/scripts/core/state');
    const progressHandlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');
    const approvalHandlers = await import('../../../src/webview/scripts/core/messageHandlers/approvals');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    // Reset state
    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // Simulate live events
    progressHandlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Running commands' });
    approvalHandlers.handleRequestToolApproval({
      type: 'requestToolApproval',
      approval: { id: 'approval_abc', command: 'npm install', cwd: '/project', severity: 'medium' }
    });
    approvalHandlers.handleToolApprovalResult({
      type: 'toolApprovalResult',
      approvalId: 'approval_abc',
      status: 'approved',
      command: 'npm install papaparse',
      output: 'Exit code: 0',
      exitCode: 0
    });
    progressHandlers.handleShowToolAction({
      type: 'showToolAction',
      status: 'success',
      icon: '⚡',
      text: 'Command completed',
      detail: 'exit 0'
    });
    progressHandlers.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const liveTimeline = state.timeline.value;

    // Build from persisted messages (what history would see)
    const makeUiEvent = (id: string, eventType: string, payload: any) => ({
      id,
      role: 'tool',
      toolName: '__ui__',
      toolOutput: JSON.stringify({ eventType, payload })
    });

    const messages = [
      { id: 'a1', role: 'assistant', content: '' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Running commands' }),
      makeUiEvent('ui2', 'requestToolApproval', {
        id: 'approval_abc',
        command: 'npm install',
        cwd: '/project',
        severity: 'medium'
      }),
      makeUiEvent('ui3', 'toolApprovalResult', {
        approvalId: 'approval_abc',
        status: 'approved',
        command: 'npm install papaparse',
        output: 'Exit code: 0',
        exitCode: 0
      }),
      makeUiEvent('ui4', 'showToolAction', {
        status: 'success',
        icon: '⚡',
        text: 'Command completed',
        detail: 'exit 0'
      }),
      makeUiEvent('ui5', 'finishProgressGroup', {})
    ];

    const historyTimeline = builder.buildTimelineFromMessages(messages);

    // Both should have one assistant thread
    expect(liveTimeline.length).toBe(1);
    expect(historyTimeline.length).toBe(1);

    const liveThread = liveTimeline[0] as any;
    const historyThread = historyTimeline[0] as any;

    // Both should have tools block at index 1 (index 0 is empty text block)
    expect(liveThread.blocks[1].type).toBe('tools');
    expect(historyThread.blocks[1].type).toBe('tools');

    // Both should have 2 items: progress + approval
    expect(liveThread.blocks[1].tools.length).toBe(2);
    expect(historyThread.blocks[1].tools.length).toBe(2);

    // Progress groups should match
    const liveProgress = liveThread.blocks[1].tools[0];
    const historyProgress = historyThread.blocks[1].tools[0];

    expect(liveProgress.type).toBe('progress');
    expect(historyProgress.type).toBe('progress');
    expect(liveProgress.title).toBe(historyProgress.title);
    expect(liveProgress.status).toBe(historyProgress.status);
    expect(liveProgress.collapsed).toBe(historyProgress.collapsed);
    expect(liveProgress.actions.length).toBe(historyProgress.actions.length);

    // Actions should match
    for (let i = 0; i < liveProgress.actions.length; i++) {
      expect(liveProgress.actions[i].text).toBe(historyProgress.actions[i].text);
      expect(liveProgress.actions[i].status).toBe(historyProgress.actions[i].status);
    }

    // Approval cards should match
    const liveApproval = liveThread.blocks[1].tools[1];
    const historyApproval = historyThread.blocks[1].tools[1];

    expect(liveApproval.type).toBe('commandApproval');
    expect(historyApproval.type).toBe('commandApproval');
    expect(liveApproval.command).toBe(historyApproval.command);
    expect(liveApproval.status).toBe(historyApproval.status);
    expect(liveApproval.exitCode).toBe(historyApproval.exitCode);
  });

  test('file edit approval workflow produces same structure as timelineBuilder', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const progressHandlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');
    const approvalHandlers = await import('../../../src/webview/scripts/core/messageHandlers/approvals');
    const builder = await import('../../../src/webview/scripts/core/timelineBuilder');

    // Reset state
    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // Simulate live events for file edit with approval
    progressHandlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Writing files' });
    progressHandlers.handleShowToolAction({
      type: 'showToolAction',
      status: 'pending',
      icon: '✏️',
      text: 'Write package.json',
      detail: 'Awaiting approval'
    });
    approvalHandlers.handleRequestFileEditApproval({
      type: 'requestFileEditApproval',
      approval: {
        id: 'file_edit_123',
        filePath: 'package.json',
        severity: 'high',
        reason: 'Matched sensitive pattern',
        diffHtml: '<div>diff</div>'
      }
    });
    progressHandlers.handleShowToolAction({
      type: 'showToolAction',
      status: 'running',
      icon: '✏️',
      text: 'Write package.json',
      detail: 'package.json'
    });
    approvalHandlers.handleFileEditApprovalResult({
      type: 'fileEditApprovalResult',
      approvalId: 'file_edit_123',
      status: 'approved',
      autoApproved: false,
      filePath: 'package.json'
    });
    progressHandlers.handleShowToolAction({
      type: 'showToolAction',
      status: 'success',
      icon: '✏️',
      text: 'Wrote package.json',
      detail: ''
    });
    progressHandlers.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const liveTimeline = state.timeline.value;

    // Build from persisted messages
    const makeUiEvent = (id: string, eventType: string, payload: any) => ({
      id,
      role: 'tool',
      toolName: '__ui__',
      toolOutput: JSON.stringify({ eventType, payload })
    });

    const messages = [
      { id: 'a1', role: 'assistant', content: '' },
      makeUiEvent('ui1', 'startProgressGroup', { title: 'Writing files' }),
      makeUiEvent('ui2', 'showToolAction', {
        status: 'pending',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'Awaiting approval'
      }),
      makeUiEvent('ui3', 'requestFileEditApproval', {
        id: 'file_edit_123',
        filePath: 'package.json',
        severity: 'high',
        reason: 'Matched sensitive pattern',
        diffHtml: '<div>diff</div>'
      }),
      makeUiEvent('ui4', 'showToolAction', {
        status: 'running',
        icon: '✏️',
        text: 'Write package.json',
        detail: 'package.json'
      }),
      makeUiEvent('ui5', 'fileEditApprovalResult', {
        approvalId: 'file_edit_123',
        status: 'approved',
        autoApproved: false,
        filePath: 'package.json'
      }),
      makeUiEvent('ui6', 'showToolAction', {
        status: 'success',
        icon: '✏️',
        text: 'Wrote package.json',
        detail: ''
      }),
      makeUiEvent('ui7', 'finishProgressGroup', {})
    ];

    const historyTimeline = builder.buildTimelineFromMessages(messages);

    // Both should have one assistant thread
    expect(liveTimeline.length).toBe(1);
    expect(historyTimeline.length).toBe(1);

    const liveThread = liveTimeline[0] as any;
    const historyThread = historyTimeline[0] as any;

    // Both should have tools block
    expect(liveThread.blocks[1].type).toBe('tools');
    expect(historyThread.blocks[1].type).toBe('tools');

    // Both should have 2 items: progress + file edit approval
    expect(liveThread.blocks[1].tools.length).toBe(2);
    expect(historyThread.blocks[1].tools.length).toBe(2);

    // Progress groups should match
    const liveProgress = liveThread.blocks[1].tools[0];
    const historyProgress = historyThread.blocks[1].tools[0];

    expect(liveProgress.type).toBe('progress');
    expect(historyProgress.type).toBe('progress');
    expect(liveProgress.title).toBe(historyProgress.title);
    expect(liveProgress.status).toBe(historyProgress.status);
    expect(liveProgress.collapsed).toBe(historyProgress.collapsed);

    // CRITICAL: Action count must be identical
    expect(liveProgress.actions.length).toBe(historyProgress.actions.length);

    // Actions should match
    for (let i = 0; i < liveProgress.actions.length; i++) {
      expect(liveProgress.actions[i].status).toBe(historyProgress.actions[i].status);
    }

    // File edit approval cards should match
    const liveApproval = liveThread.blocks[1].tools[1];
    const historyApproval = historyThread.blocks[1].tools[1];

    expect(liveApproval.type).toBe('fileEditApproval');
    expect(historyApproval.type).toBe('fileEditApproval');
    expect(liveApproval.filePath).toBe(historyApproval.filePath);
    expect(liveApproval.status).toBe(historyApproval.status);
    expect(liveApproval.autoApproved).toBe(historyApproval.autoApproved);
    expect(liveApproval.severity).toBe(historyApproval.severity);
  });
});

// --- Regression: connectionTestResult correctly populates model list ---

describe('connectionTestResult handler', () => {
  test('handleConnectionTestResult populates modelOptions from models array', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    state.modelOptions.value = [];

    handlers.handleConnectionTestResult({
      type: 'connectionTestResult',
      success: true,
      message: 'Connected successfully!',
      models: [
        { name: 'llama3.1:8b' },
        { name: 'codestral:latest' },
        { name: 'devstral:latest' }
      ]
    });

    expect(state.modelOptions.value).toEqual([
      'llama3.1:8b',
      'codestral:latest',
      'devstral:latest'
    ]);
  });

  test('handleConnectionTestResult sets currentModel via syncModelSelection', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    state.modelOptions.value = [];
    state.currentModel.value = '';
    state.settings.agentModel = '';

    handlers.handleConnectionTestResult({
      type: 'connectionTestResult',
      success: true,
      message: 'Connected!',
      models: [{ name: 'model-a' }, { name: 'model-b' }]
    });

    // syncModelSelection should pick the first model when no preference is set
    expect(state.currentModel.value).toBe('model-a');
  });

  test('handleConnectionTestResult does not clear models on error (no models field)', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    // Pre-populate models
    state.modelOptions.value = ['existing-model'];

    handlers.handleConnectionTestResult({
      type: 'connectionTestResult',
      success: false,
      message: 'Connection refused'
      // No models field — should NOT clear existing models
    });

    expect(state.modelOptions.value).toEqual(['existing-model']);
  });

  test('handleSettingsUpdate does not clear modelOptions', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    // Pre-populate models (from a previous connectionTestResult)
    state.modelOptions.value = ['model-a', 'model-b'];
    state.currentModel.value = 'model-a';

    // settingsUpdate arrives (from saveSettings completing) — should NOT clear models
    handlers.handleSettingsUpdate({
      type: 'settingsUpdate',
      settings: {
        baseUrl: 'http://localhost:11434',
        agentModel: 'model-a'
      },
      hasToken: true
    });

    expect(state.modelOptions.value).toEqual(['model-a', 'model-b']);
  });
});

describe('thinking block handlers', () => {
  test('handleStreamThinking creates thinking block in assistant thread', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStreamThinking({ type: 'streamThinking', content: 'Let me think...' });

    expect(state.timeline.value.length).toBe(1);
    const thread = state.timeline.value[0] as any;
    // Should have: empty text block + thinking block
    const thinkingBlocks = thread.blocks.filter((b: any) => b.type === 'thinking');
    expect(thinkingBlocks.length).toBe(1);
    expect(thinkingBlocks[0].content).toBe('Let me think...');
    expect(thinkingBlocks[0].collapsed).toBe(false);
  });

  test('handleStreamThinking updates existing uncollapsed thinking block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStreamThinking({ type: 'streamThinking', content: 'Step 1' });
    handlers.handleStreamThinking({ type: 'streamThinking', content: 'Step 1\nStep 2' });

    const thread = state.timeline.value[0] as any;
    const thinkingBlocks = thread.blocks.filter((b: any) => b.type === 'thinking');
    // Should still be one block, updated
    expect(thinkingBlocks.length).toBe(1);
    expect(thinkingBlocks[0].content).toBe('Step 1\nStep 2');
  });

  test('handleCollapseThinking collapses uncollapsed thinking blocks', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStreamThinking({ type: 'streamThinking', content: 'My reasoning' });

    const thread = state.timeline.value[0] as any;
    const thinkingBlock = thread.blocks.find((b: any) => b.type === 'thinking');
    expect(thinkingBlock.collapsed).toBe(false);

    handlers.handleCollapseThinking({ type: 'collapseThinking' });
    expect(thinkingBlock.collapsed).toBe(true);
  });

  test('new streamThinking after collapse creates a new block', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/streaming');

    state.timeline.value = [];
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    // First thinking round
    handlers.handleStreamThinking({ type: 'streamThinking', content: 'First thought' });
    handlers.handleCollapseThinking({ type: 'collapseThinking' });

    // Second thinking round
    handlers.handleStreamThinking({ type: 'streamThinking', content: 'Second thought' });

    const thread = state.timeline.value[0] as any;
    const thinkingBlocks = thread.blocks.filter((b: any) => b.type === 'thinking');
    expect(thinkingBlocks.length).toBe(2);
    expect(thinkingBlocks[0].content).toBe('First thought');
    expect(thinkingBlocks[0].collapsed).toBe(true);
    expect(thinkingBlocks[1].content).toBe('Second thought');
    expect(thinkingBlocks[1].collapsed).toBe(false);
  });
});

describe('warning banner handler', () => {
  test('handleShowWarningBanner sets banner state', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    state.warningBanner.visible = false;
    state.warningBanner.message = '';

    handlers.handleShowWarningBanner({
      type: 'showWarningBanner',
      message: 'This model may not support tool calling'
    });

    expect(state.warningBanner.visible).toBe(true);
    expect(state.warningBanner.message).toBe('This model may not support tool calling');
  });

  test('handleShowWarningBanner ignores different session', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    state.currentSessionId.value = 'session-1';
    state.warningBanner.visible = false;
    state.warningBanner.message = '';

    handlers.handleShowWarningBanner({
      type: 'showWarningBanner',
      sessionId: 'session-2',
      message: 'Should not appear'
    });

    expect(state.warningBanner.visible).toBe(false);
    expect(state.warningBanner.message).toBe('');
  });
});

describe('chunked read_file handlers', () => {
  test('handleShowToolAction preserves startLine on action items', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading file' });
    handlers.handleShowToolAction({
      type: 'showToolAction',
      status: 'success',
      icon: '📄',
      text: 'Read main.ts',
      detail: 'lines 1–100',
      filePath: 'src/main.ts',
      startLine: 1
    });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks[1].tools[0];
    expect(group.actions[0].startLine).toBe(1);
    expect(group.actions[0].filePath).toBe('src/main.ts');
  });

  test('handleShowToolAction preserves filePath without checkpointId for reads', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading' });
    handlers.handleShowToolAction({
      type: 'showToolAction',
      status: 'success',
      icon: '📄',
      text: 'Read config.ts',
      detail: 'lines 1–50',
      filePath: 'src/config.ts',
      startLine: 1
    });

    const thread = state.timeline.value[0] as any;
    const action = thread.blocks[1].tools[0].actions[0];
    expect(action.filePath).toBe('src/config.ts');
    expect(action.checkpointId).toBeUndefined();
    expect(action.startLine).toBe(1);
  });

  test('multiple chunk success actions create separate action items', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const handlers = await import('../../../src/webview/scripts/core/messageHandlers/progress');

    state.timeline.value = [];
    state.currentProgressIndex.value = null;
    state.currentStreamIndex.value = null;
    state.currentAssistantThreadId.value = null;

    handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Reading file.ts' });

    // Chunk 1 running then success
    handlers.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '📄',
      text: 'Reading file.ts', detail: 'lines 1–100',
      filePath: 'src/file.ts', startLine: 1
    });
    handlers.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '📄',
      text: 'Read file.ts', detail: 'lines 1–100',
      filePath: 'src/file.ts', startLine: 1
    });

    // Chunk 2 running then success
    handlers.handleShowToolAction({
      type: 'showToolAction', status: 'running', icon: '📄',
      text: 'Reading file.ts', detail: 'lines 101–200',
      filePath: 'src/file.ts', startLine: 101
    });
    handlers.handleShowToolAction({
      type: 'showToolAction', status: 'success', icon: '📄',
      text: 'Read file.ts', detail: 'lines 101–200',
      filePath: 'src/file.ts', startLine: 101
    });

    handlers.handleFinishProgressGroup({ type: 'finishProgressGroup' });

    const thread = state.timeline.value[0] as any;
    const group = thread.blocks[1].tools[0];
    expect(group.status).toBe('done');
    expect(group.actions.length).toBe(2);
    expect(group.actions[0].text).toBe('Read file.ts');
    expect(group.actions[0].detail).toBe('lines 1–100');
    expect(group.actions[1].text).toBe('Read file.ts');
    expect(group.actions[1].detail).toBe('lines 101–200');
  });
});
