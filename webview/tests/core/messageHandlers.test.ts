import { beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

test('handleStreamChunk writes into contentBefore when no tools', async () => {
  const state = await import('../../scripts/core/state');
  const handlers = await import('../../scripts/core/messageHandlers/streaming');

  state.timeline.value = [];
  state.currentStreamIndex.value = null;

  handlers.handleStreamChunk({ type: 'streamChunk', content: 'Hello', model: 'm1' });

  expect(state.timeline.value.length).toBe(1);
  const thread = state.timeline.value[0] as any;
  expect(thread.type).toBe('assistantThread');
  expect(thread.contentBefore).toBe('Hello');
  expect(thread.contentAfter).toBe('');
  expect(thread.model).toBe('m1');
});

test('progress group lifecycle updates status and collapses', async () => {
  const state = await import('../../scripts/core/state');
  const handlers = await import('../../scripts/core/messageHandlers/progress');

  state.timeline.value = [];
  state.currentProgressIndex.value = null;
  state.currentStreamIndex.value = null;

  handlers.handleStartProgressGroup({ type: 'startProgressGroup', title: 'Working' });
  expect(state.timeline.value.length).toBe(1);
  const thread = state.timeline.value[0] as any;
  const group = thread.tools[0];
  expect(group.status).toBe('running');
  expect(group.title).toBe('Working');

  handlers.handleShowToolAction({ type: 'showToolAction', text: 'Step 1', status: 'running' });
  expect(group.actions.length).toBe(1);
  expect(group.actions[0].status).toBe('running');

  handlers.handleShowToolAction({ type: 'showToolAction', text: 'Step 1', status: 'success' });
  expect(group.actions[0].status).toBe('success');
  expect(group.status).toBe('done');

  handlers.handleFinishProgressGroup({ type: 'finishProgressGroup' });
  expect(group.collapsed).toBe(true);
  expect(state.currentProgressIndex.value).toBe(null);
});

test('handleToolApprovalResult updates command and exit code', async () => {
  const state = await import('../../scripts/core/state');
  const handlers = await import('../../scripts/core/messageHandlers/approvals');

  state.timeline.value = [];
  state.currentStreamIndex.value = null;

  handlers.handleRequestToolApproval({
    type: 'requestToolApproval',
    approval: { id: 'a1', command: 'echo hi', cwd: '/tmp', severity: 'medium' }
  });

  handlers.handleToolApprovalResult({
    type: 'toolApprovalResult',
    approvalId: 'a1',
    status: 'approved',
    output: 'Exit code: 0',
    command: 'echo hello',
    exitCode: 0
  });

  const thread = state.timeline.value[0] as any;
  const approval = thread.tools.find((item: any) => item.type === 'commandApproval');
  expect(approval.command).toBe('echo hello');
  expect(approval.exitCode).toBe(0);
  expect(approval.status).toBe('approved');
});
