import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import ChatInput from '../../../src/webview/components/chat/components/ChatInput.vue';

// Stub child components that use Teleport (DropdownMenu is in PillPicker and attach menu)
vi.mock('../../../src/webview/components/chat/components/DropdownMenu.vue', () => ({
  default: {
    name: 'DropdownMenu',
    props: ['items', 'modelValue', 'anchorRect'],
    emits: ['select', 'close'],
    template: `
      <div class="mock-dropdown">
        <button
          v-for="item in items"
          :key="item.id"
          class="mock-dropdown-item"
          :data-id="item.id"
          @click="$emit('select', item.id)"
        >{{ item.label }}</button>
      </div>
    `
  }
}));

const baseProps = {
  contextList: [] as any[],
  inputText: '',
  currentMode: 'agent',
  currentModel: 'llama3',
  modelOptions: ['llama3', 'codellama'],
  isGenerating: false,
  implicitFile: null as any,
  implicitSelection: null as any,
  implicitFileEnabled: true,
  toolsActive: false,
  onInputText: vi.fn(),
  onModeChange: vi.fn(),
  onModelChange: vi.fn(),
  addContext: vi.fn(),
  addContextFromFile: vi.fn(),
  addContextCurrentFile: vi.fn(),
  addContextFromTerminal: vi.fn(),
  removeContext: vi.fn(),
  handleEnter: vi.fn(),
  handleSend: vi.fn(),
  setInputEl: vi.fn(),
  toggleImplicitFile: vi.fn(),
  promoteImplicitFile: vi.fn(),
  pinSelection: vi.fn()
};

describe('ChatInput', () => {
  // --- Implicit file chip ---

  test('shows implicit file chip when file is set and not duplicated', () => {
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        implicitFile: { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' }
      },
      attachTo: document.body
    });

    const chips = wrapper.findAll('.context-chip.implicit');
    expect(chips.length).toBeGreaterThanOrEqual(1);
    expect(chips[0].text()).toContain('app.ts');
  });

  test('hides implicit file chip when same file is in explicit context', () => {
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        implicitFile: { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' },
        contextList: [{ fileName: 'app.ts', content: 'code' }]
      },
      attachTo: document.body
    });

    // No implicit file chip (deduplication)
    const implicitChips = wrapper.findAll('.context-chip.implicit:not(.selection)');
    expect(implicitChips.length).toBe(0);
  });

  test('hides implicit file chip when explicit context uses relative path', () => {
    // Backend addContextCurrentFile sends relativePath ("demo-project/app.ts")
    // while EditorContextTracker sends basename as fileName ("app.ts").
    // showImplicitFile must check against relativePath too.
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        implicitFile: { fileName: 'app.ts', filePath: '/demo-project/app.ts', relativePath: 'demo-project/app.ts', languageId: 'typescript' },
        contextList: [{ fileName: 'demo-project/app.ts', content: 'code' }]
      },
      attachTo: document.body
    });

    const implicitChips = wrapper.findAll('.context-chip.implicit:not(.selection)');
    expect(implicitChips.length).toBe(0);
  });

  test('implicit file chip shows disabled class in agent mode', () => {
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        currentMode: 'agent',
        implicitFile: { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' }
      },
      attachTo: document.body
    });

    const chip = wrapper.find('.context-chip.implicit');
    expect(chip.classes()).toContain('disabled');
  });

  test('implicit file chip is NOT disabled in chat mode', () => {
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        currentMode: 'chat',
        implicitFile: { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' }
      },
      attachTo: document.body
    });

    const chip = wrapper.find('.context-chip.implicit:not(.selection)');
    expect(chip.classes()).not.toContain('disabled');
  });

  test('clicking implicit file chip in agent mode calls promoteImplicitFile', async () => {
    const promoteImplicitFile = vi.fn();
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        currentMode: 'agent',
        implicitFile: { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' },
        promoteImplicitFile
      },
      attachTo: document.body
    });

    await wrapper.find('.context-chip.implicit').trigger('click');
    expect(promoteImplicitFile).toHaveBeenCalled();
  });

  // --- Implicit selection chip ---

  test('shows implicit selection chip with line range', () => {
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        implicitSelection: {
          fileName: 'index.ts',
          content: 'code here',
          startLine: 10,
          endLine: 20,
          languageId: 'typescript'
        }
      },
      attachTo: document.body
    });

    const selChip = wrapper.find('.context-chip.implicit.selection');
    expect(selChip.exists()).toBe(true);
    expect(selChip.text()).toContain('index.ts:L10-L20');
  });

  test('clicking pin on selection chip calls pinSelection', async () => {
    const pinSelection = vi.fn();
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        implicitSelection: {
          fileName: 'index.ts',
          content: 'code',
          startLine: 1,
          endLine: 5,
          languageId: 'typescript'
        },
        pinSelection
      },
      attachTo: document.body
    });

    await wrapper.find('.context-chip.implicit.selection .codicon-pinned').trigger('click');
    expect(pinSelection).toHaveBeenCalled();
  });

  // --- Explicit context chips ---

  test('renders explicit context chips with remove button', async () => {
    const removeContext = vi.fn();
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        contextList: [
          { fileName: 'a.ts', content: 'x' },
          { fileName: 'b.ts', content: 'y' }
        ],
        removeContext
      },
      attachTo: document.body
    });

    const explicitChips = wrapper.findAll('.context-chip.explicit');
    expect(explicitChips).toHaveLength(2);
    expect(explicitChips[0].text()).toContain('a.ts');

    await explicitChips[0].find('.codicon-close').trigger('click');
    expect(removeContext).toHaveBeenCalledWith(0);
  });

  // --- Mode picker ---

  test('renders mode picker with current mode', () => {
    const wrapper = mount(ChatInput, {
      props: { ...baseProps, currentMode: 'agent' },
      attachTo: document.body
    });

    // First pill picker contains the mode label
    const pills = wrapper.findAll('.pill-label');
    expect(pills[0].text()).toBe('Agent');
  });

  // --- Tools button ---

  test('shows tools button only in agent mode', () => {
    const agentWrapper = mount(ChatInput, {
      props: { ...baseProps, currentMode: 'agent' },
      attachTo: document.body
    });
    expect(agentWrapper.find('.tools-btn').exists()).toBe(true);

    const askWrapper = mount(ChatInput, {
      props: { ...baseProps, currentMode: 'chat' },
      attachTo: document.body
    });
    expect(askWrapper.find('.tools-btn').exists()).toBe(false);
  });

  test('tools button emits toggleTools on click', async () => {
    const wrapper = mount(ChatInput, {
      props: { ...baseProps, currentMode: 'agent' },
      attachTo: document.body
    });

    await wrapper.find('.tools-btn').trigger('click');
    expect(wrapper.emitted('toggleTools')).toHaveLength(1);
  });

  // --- Send button ---

  test('send button shows send icon normally, stop icon when generating', () => {
    const normalWrapper = mount(ChatInput, {
      props: { ...baseProps, isGenerating: false },
      attachTo: document.body
    });
    expect(normalWrapper.find('.send-btn .codicon-send').exists()).toBe(true);

    const genWrapper = mount(ChatInput, {
      props: { ...baseProps, isGenerating: true },
      attachTo: document.body
    });
    expect(genWrapper.find('.send-btn .codicon-debug-stop').exists()).toBe(true);
  });

  test('send button calls handleSend on click', async () => {
    const handleSend = vi.fn();
    const wrapper = mount(ChatInput, {
      props: { ...baseProps, handleSend },
      attachTo: document.body
    });

    await wrapper.find('.send-btn').trigger('click');
    expect(handleSend).toHaveBeenCalled();
  });

  // --- Attach menu ---

  test('opens attach menu on attach button click', async () => {
    const wrapper = mount(ChatInput, {
      props: baseProps,
      attachTo: document.body
    });

    expect(wrapper.find('.attach-trigger .mock-dropdown').exists()).toBe(false);
    await wrapper.find('.attach-btn').trigger('click');
    expect(wrapper.find('.attach-trigger .mock-dropdown').exists()).toBe(true);
  });

  test('attach menu selection calls correct handler', async () => {
    const addContextFromFile = vi.fn();
    const addContextCurrentFile = vi.fn();
    const addContextFromTerminal = vi.fn();
    const addContext = vi.fn();
    const wrapper = mount(ChatInput, {
      props: {
        ...baseProps,
        addContextFromFile,
        addContextCurrentFile,
        addContextFromTerminal,
        addContext
      },
      attachTo: document.body
    });

    // Open menu
    await wrapper.find('.attach-btn').trigger('click');

    // Click "file" item
    await wrapper.find('.mock-dropdown-item[data-id="file"]').trigger('click');
    expect(addContextFromFile).toHaveBeenCalled();
  });

  // --- New modes: plan, chat ---

  test('renders mode picker with "Chat" when currentMode=chat', () => {
    const wrapper = mount(ChatInput, {
      props: { ...baseProps, currentMode: 'chat' },
      attachTo: document.body
    });
    const pills = wrapper.findAll('.pill-label');
    expect(pills[0].text()).toBe('Chat');
  });

  test('renders mode picker with "Plan" when currentMode=plan', () => {
    const wrapper = mount(ChatInput, {
      props: { ...baseProps, currentMode: 'plan' },
      attachTo: document.body
    });
    const pills = wrapper.findAll('.pill-label');
    expect(pills[0].text()).toBe('Plan');
  });

  test('tools button is hidden in plan and chat modes', () => {
    const modes = ['plan', 'chat'] as const;
    for (const mode of modes) {
      const wrapper = mount(ChatInput, {
        props: { ...baseProps, currentMode: mode },
        attachTo: document.body
      });
      expect(wrapper.find('.tools-btn').exists()).toBe(false);
    }
  });
});
