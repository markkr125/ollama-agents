import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import SettingsPage from '../../../src/webview/components/settings/SettingsPage.vue';
import { useSettingsPage } from '../../../src/webview/scripts/core/settings';
import { isFirstRun, sessionSensitiveFilePatterns } from '../../../src/webview/scripts/core/state';

// Mock the actions module so we don't pull in the full state/postMessage chain
vi.mock('../../../src/webview/scripts/core/actions/index', () => ({
  updateSessionSensitivePatterns: vi.fn()
}));

import { updateSessionSensitivePatterns } from '../../../src/webview/scripts/core/actions/index';

// --- Helper: minimal SettingsPage props ---
function makeProps(overrides: Record<string, any> = {}) {
  const status = { visible: false, success: true, message: '' };
  return {
    currentPage: 'settings' as const,
    activeSection: 'connection',
    setActiveSection: vi.fn(),
    settings: {
      baseUrl: 'http://localhost:11434',
      enableAutoComplete: true,
      agentModel: '',
      chatModel: '',
      completionModel: '',
      maxIterations: 25,
      toolTimeout: 30000,
      maxActiveSessions: 1,
      enableThinking: true,
      temperature: 0.7,
      sensitiveFilePatterns: '',
      storagePath: ''
    },
    saveBaseUrl: vi.fn(),
    tokenVisible: false,
    bearerToken: '',
    setBearerToken: vi.fn(),
    hasToken: false,
    toggleToken: vi.fn(),
    testConnection: vi.fn(),
    saveBearerToken: vi.fn(),
    statusClass: () => ({}),
    connectionStatus: { ...status },
    modelOptions: ['model-a', 'model-b'],
    saveModelSettings: vi.fn(),
    chatSettings: { streamResponses: true, showToolActions: true },
    temperatureSlider: 70,
    setTemperatureSlider: vi.fn(),
    temperatureDisplay: '0.70',
    toggleAutocomplete: vi.fn(),
    autocomplete: { autoTrigger: true, triggerDelay: 500, maxTokens: 500 },
    agentSettings: { autoCreateBranch: true, autoCommit: false },
    toolTimeoutSeconds: 30,
    setToolTimeoutSeconds: vi.fn(),
    saveAgentSettings: vi.fn(),
    agentStatus: { ...status },
    tools: [
      { name: 'read_file', icon: '📄', desc: 'Read file contents' }
    ],
    modelInfo: [],
    capabilityCheckProgress: { running: false, completed: 0, total: 0 },
    refreshCapabilities: vi.fn(),
    toggleModelEnabled: vi.fn(),
    updateModelMaxContext: vi.fn(),
    saveMaxContextWindow: vi.fn(),
    runDbMaintenance: vi.fn(),
    saveStoragePath: vi.fn(),
    dbMaintenanceStatus: { ...status },
    recreateMessagesTable: vi.fn(),
    recreateMessagesStatus: { ...status },
    ...overrides
  };
}

// --- useSettingsPage composable tests ---

describe('useSettingsPage composable', () => {
  const callbacks = {
    setBearerToken: vi.fn(),
    setTemperatureSlider: vi.fn(),
    setToolTimeoutSeconds: vi.fn(),
    recreateMessagesTable: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isFirstRun.value = false;
    sessionSensitiveFilePatterns.value = '';
  });

  test('onBearerInput calls setBearerToken with input value', () => {
    const { onBearerInput } = useSettingsPage(callbacks);
    const event = { target: { value: 'my-secret-token' } } as unknown as Event;

    onBearerInput(event);

    expect(callbacks.setBearerToken).toHaveBeenCalledWith('my-secret-token');
  });

  test('onTemperatureInput calls setTemperatureSlider with numeric value', () => {
    const { onTemperatureInput } = useSettingsPage(callbacks);
    const event = { target: { value: '85' } } as unknown as Event;

    onTemperatureInput(event);

    expect(callbacks.setTemperatureSlider).toHaveBeenCalledWith(85);
  });

  test('onToolTimeoutInput calls setToolTimeoutSeconds with numeric value', () => {
    const { onToolTimeoutInput } = useSettingsPage(callbacks);
    const event = { target: { value: '60' } } as unknown as Event;

    onToolTimeoutInput(event);

    expect(callbacks.setToolTimeoutSeconds).toHaveBeenCalledWith(60);
  });

  test('confirmRecreateMessagesTable delegates to recreateMessagesTable', () => {
    const { confirmRecreateMessagesTable } = useSettingsPage(callbacks);

    confirmRecreateMessagesTable();

    expect(callbacks.recreateMessagesTable).toHaveBeenCalledOnce();
  });

  test('dismissWelcome sets isFirstRun to false', () => {
    isFirstRun.value = true;
    const { dismissWelcome } = useSettingsPage(callbacks);

    dismissWelcome();

    expect(isFirstRun.value).toBe(false);
  });

  test('localSessionPatterns syncs with sessionSensitiveFilePatterns immediately', () => {
    sessionSensitiveFilePatterns.value = '{"**/*": true}';
    const { localSessionPatterns } = useSettingsPage(callbacks);

    expect(localSessionPatterns.value).toBe('{"**/*": true}');
  });

  test('localSessionPatterns updates when sessionSensitiveFilePatterns changes', async () => {
    const { localSessionPatterns } = useSettingsPage(callbacks);
    expect(localSessionPatterns.value).toBe('');

    sessionSensitiveFilePatterns.value = '{"src/**": false}';
    await nextTick();

    expect(localSessionPatterns.value).toBe('{"src/**": false}');
  });

  test('localSessionPatterns defaults to empty string for falsy values', async () => {
    sessionSensitiveFilePatterns.value = 'something';
    const { localSessionPatterns } = useSettingsPage(callbacks);
    expect(localSessionPatterns.value).toBe('something');

    (sessionSensitiveFilePatterns as any).value = '';
    await nextTick();

    expect(localSessionPatterns.value).toBe('');
  });

  test('saveSessionPatterns calls updateSessionSensitivePatterns with current value', () => {
    sessionSensitiveFilePatterns.value = '{"**/*": true}';
    const { localSessionPatterns, saveSessionPatterns } = useSettingsPage(callbacks);

    // Edit the local value
    localSessionPatterns.value = '{"**/*.ts": false}';
    saveSessionPatterns();

    expect(updateSessionSensitivePatterns).toHaveBeenCalledWith('{"**/*.ts": false}');
  });
});

// --- SettingsPage component tests ---

describe('SettingsPage component', () => {
  beforeEach(() => {
    isFirstRun.value = false;
    sessionSensitiveFilePatterns.value = '';
  });

  test('renders welcome banner when isFirstRun is true', () => {
    isFirstRun.value = true;
    const wrapper = mount(SettingsPage, { props: makeProps() });

    expect(wrapper.find('.welcome-banner').exists()).toBe(true);
    expect(wrapper.text()).toContain('Welcome to Ollama Copilot');
  });

  test('hides welcome banner when isFirstRun is false', () => {
    isFirstRun.value = false;
    const wrapper = mount(SettingsPage, { props: makeProps() });

    expect(wrapper.find('.welcome-banner').exists()).toBe(false);
  });

  test('dismiss button sets isFirstRun to false', async () => {
    isFirstRun.value = true;
    const wrapper = mount(SettingsPage, { props: makeProps() });

    await wrapper.find('.welcome-dismiss').trigger('click');

    expect(isFirstRun.value).toBe(false);
    await nextTick();
    expect(wrapper.find('.welcome-banner').exists()).toBe(false);
  });

  test('renders all navigation sections', () => {
    const wrapper = mount(SettingsPage, { props: makeProps() });
    const navItems = wrapper.findAll('.settings-nav-item');

    const labels = navItems.map(n => n.text());
    expect(labels).toEqual([
      'Connection', 'Models', 'Chat', 'Autocomplete', 'Agent', 'Tools', 'Advanced'
    ]);
  });

  test('clicking a nav item calls setActiveSection', async () => {
    const setActiveSection = vi.fn();
    const wrapper = mount(SettingsPage, {
      props: makeProps({ setActiveSection })
    });

    const modelsNav = wrapper.findAll('.settings-nav-item')[1];
    await modelsNav.trigger('click');

    expect(setActiveSection).toHaveBeenCalledWith('models');
  });

  test('active nav item has active class', () => {
    const wrapper = mount(SettingsPage, {
      props: makeProps({ activeSection: 'agent' })
    });

    const navItems = wrapper.findAll('.settings-nav-item');
    const agentNav = navItems[4]; // Agent is 5th (0-indexed: 4)
    expect(agentNav.classes()).toContain('active');
  });

  test('page is visible only when currentPage is settings', () => {
    const wrapperVisible = mount(SettingsPage, {
      props: makeProps({ currentPage: 'settings' })
    });
    expect(wrapperVisible.find('.page').classes()).toContain('active');

    const wrapperHidden = mount(SettingsPage, {
      props: makeProps({ currentPage: 'chat' })
    });
    expect(wrapperHidden.find('.page').classes()).not.toContain('active');
  });

  test('recreate messages table button calls confirmRecreateMessagesTable', async () => {
    const recreateMessagesTable = vi.fn();
    const wrapper = mount(SettingsPage, {
      props: makeProps({ activeSection: 'advanced', recreateMessagesTable })
    });

    await wrapper.find('.btn-danger').trigger('click');

    expect(recreateMessagesTable).toHaveBeenCalledOnce();
  });

  test('test connection button calls testConnection prop', async () => {
    const testConnection = vi.fn();
    const wrapper = mount(SettingsPage, {
      props: makeProps({ activeSection: 'connection', testConnection })
    });

    const buttons = wrapper.findAll('.btn-secondary');
    const testBtn = buttons.find(b => b.text() === 'Test Connection');
    expect(testBtn).toBeDefined();
    await testBtn!.trigger('click');

    expect(testConnection).toHaveBeenCalledOnce();
  });

  test('model options render in select dropdowns', () => {
    const wrapper = mount(SettingsPage, {
      props: makeProps({
        activeSection: 'models',
        modelOptions: ['llama3', 'codellama'],
        modelInfo: [
          { name: 'llama3', size: 0, capabilities: { chat: true, fim: true, tools: false, vision: false, embedding: false }, enabled: true },
          { name: 'codellama', size: 0, capabilities: { chat: true, fim: true, tools: false, vision: false, embedding: false }, enabled: true }
        ]
      })
    });

    const options = wrapper.findAll('option');
    const optionValues = options.map(o => o.text());
    // 4 selects (Agent, Chat, Completion, Explorer) × 2 options = 8
    expect(optionValues.filter(v => v === 'llama3').length).toBe(4);
    expect(optionValues.filter(v => v === 'codellama').length).toBe(4);
  });
});
