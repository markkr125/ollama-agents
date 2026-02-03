import { beforeEach, expect, test, vi } from 'vitest';
import { vscodePostMessage } from '../setup';

beforeEach(async () => {
  vscodePostMessage.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-03T00:00:00Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

test('toggle/confirm auto-approve posts setAutoApprove', async () => {
  const state = await import('../../scripts/core/state');
  const actions = await import('../../scripts/core/actions/index');

  state.currentSessionId.value = 's1';
  state.autoApproveCommands.value = false;
  state.autoApproveConfirmVisible.value = false;

  actions.toggleAutoApproveCommands();
  expect(state.autoApproveConfirmVisible.value).toBe(true);
  expect(state.autoApproveCommands.value).toBe(false);
  expect(vscodePostMessage).not.toHaveBeenCalled();

  actions.confirmAutoApproveCommands();
  expect(state.autoApproveCommands.value).toBe(true);
  expect(vscodePostMessage).toHaveBeenCalledWith({
    type: 'setAutoApprove',
    sessionId: 's1',
    enabled: true
  });

  // Turning it off should immediately post
  actions.toggleAutoApproveCommands();
  expect(state.autoApproveCommands.value).toBe(false);
  expect(vscodePostMessage).toHaveBeenCalledWith({
    type: 'setAutoApprove',
    sessionId: 's1',
    enabled: false
  });
});

test('ensureProgressGroup creates one progress group', async () => {
  const state = await import('../../scripts/core/state');
  const actions = await import('../../scripts/core/actions/index');

  state.timeline.value = [];
  state.currentProgressIndex.value = null;

  actions.ensureProgressGroup('Analyzing code');
  expect(state.timeline.value.length).toBe(1);
  expect(state.timeline.value[0].type).toBe('progress');
  expect((state.timeline.value[0] as any).title).toBe('Analyzing code');
  expect(state.currentProgressIndex.value).toBe(0);

  actions.ensureProgressGroup('Should not create second');
  expect(state.timeline.value.length).toBe(1);
});

test('startAssistantMessage creates assistant thread and sets stream index', async () => {
  const state = await import('../../scripts/core/state');
  const actions = await import('../../scripts/core/actions/index');

  state.timeline.value = [];
  state.currentStreamIndex.value = null;

  actions.startAssistantMessage('test-model');
  expect(state.timeline.value.length).toBe(1);
  expect(state.timeline.value[0].type).toBe('assistantThread');
  expect((state.timeline.value[0] as any).model).toBe('test-model');
  expect(state.currentStreamIndex.value).toBe(0);
});

test('handleSend posts sendMessage with context and clears input/context', async () => {
  const state = await import('../../scripts/core/state');
  const actions = await import('../../scripts/core/actions/index');

  state.isGenerating.value = false;
  state.currentSessionId.value = 's1';
  state.inputText.value = '  hello  ';
  state.contextList.value = [{ fileName: 'a.ts', content: 'x' }];

  actions.handleSend();

  expect(vscodePostMessage).toHaveBeenCalledWith({
    type: 'sendMessage',
    text: 'hello',
    context: [{ fileName: 'a.ts', content: 'x' }]
  });

  expect(state.inputText.value).toBe('');
  expect(state.contextList.value.length).toBe(0);
});

test('handleSend posts stopGeneration when already generating', async () => {
  const state = await import('../../scripts/core/state');
  const actions = await import('../../scripts/core/actions/index');

  state.isGenerating.value = true;
  state.currentSessionId.value = 's1';

  actions.handleSend();

  expect(vscodePostMessage).toHaveBeenCalledWith({
    type: 'stopGeneration',
    sessionId: 's1'
  });
});

test('handleSearchInput debounces searchSessions', async () => {
  const state = await import('../../scripts/core/state');
  const actions = await import('../../scripts/core/actions/index');

  actions.handleSearchInput('  hello world  ');
  expect(state.isSearching.value).toBe(true);
  expect(vscodePostMessage).not.toHaveBeenCalled();

  vi.advanceTimersByTime(299);
  expect(vscodePostMessage).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(vscodePostMessage).toHaveBeenCalledWith({
    type: 'searchSessions',
    query: 'hello world'
  });
});

test('highlightSnippet wraps query terms in <mark>', async () => {
  const actions = await import('../../scripts/core/actions/index');

  const out = actions.highlightSnippet('Hello world, hello!', 'hello');
  expect(out).toContain('<mark>Hello</mark>');
});
