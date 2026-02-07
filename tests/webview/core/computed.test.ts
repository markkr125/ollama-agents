import { beforeEach, expect, test, vi } from 'vitest';

beforeEach(async () => {
  vi.resetModules();
});

test('temperatureDisplay formats slider value', async () => {
  const state = await import('../../../src/webview/scripts/core/state');
  const computed = await import('../../../src/webview/scripts/core/computed');

  state.temperatureSlider.value = 75;
  expect(computed.temperatureDisplay.value).toBe('0.8');
});

test('toolTimeoutSeconds getter/setter clamps to >=1s', async () => {
  const state = await import('../../../src/webview/scripts/core/state');
  const computed = await import('../../../src/webview/scripts/core/computed');

  state.settings.toolTimeout = 30_000;
  expect(computed.toolTimeoutSeconds.value).toBe(30);

  computed.toolTimeoutSeconds.value = 0 as any;
  expect(state.settings.toolTimeout).toBe(1_000);
});

test('headerTitle switches by page', async () => {
  const state = await import('../../../src/webview/scripts/core/state');
  const computed = await import('../../../src/webview/scripts/core/computed');

  state.currentPage.value = 'chat';
  expect(computed.headerTitle.value).toBe('Copilot');

  state.currentPage.value = 'settings';
  expect(computed.headerTitle.value).toBe('Settings');

  state.currentPage.value = 'sessions';
  expect(computed.headerTitle.value).toBe('Sessions');
});

test('searchHasMore reflects visible vs total', async () => {
  const state = await import('../../../src/webview/scripts/core/state');
  const computed = await import('../../../src/webview/scripts/core/computed');

  state.allSearchResults.value = [
    {
      session: { id: 's1', title: 't1', timestamp: 1 },
      messages: [
        { id: 'm1', content: 'a', snippet: 'a', role: 'user' },
        { id: 'm2', content: 'b', snippet: 'b', role: 'assistant' }
      ]
    }
  ];

  state.searchVisibleCount.value = 1;
  expect(computed.searchHasMore.value).toBe(true);

  state.searchVisibleCount.value = 2;
  expect(computed.searchHasMore.value).toBe(false);
});
