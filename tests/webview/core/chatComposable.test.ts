/**
 * Smoke tests for useChatPage composable.
 *
 * These tests catch missing function exports (like the handleOpenFileDiff
 * deletion that killed the entire ChatPage render) by verifying the composable
 * instantiates successfully and returns all expected members.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * Helper that builds a minimal stub of ChatPageProps for the composable.
 * All functions are vi.fn() stubs; all refs are default values.
 */
function createMockProps() {
  return {
    currentPage: 'chat' as const,
    setMessagesEl: vi.fn(),
    setInputEl: vi.fn(),
    timeline: [],
    thinking: { visible: false, text: '' },
    contextList: [],
    inputText: '',
    setInputText: vi.fn(),
    currentMode: 'agent',
    setCurrentMode: vi.fn(),
    currentModel: 'llama3',
    setCurrentModel: vi.fn(),
    modelOptions: ['llama3'],
    autoApproveCommands: false,
    autoApproveConfirmVisible: false,
    toggleAutoApproveCommands: vi.fn(),
    confirmAutoApproveCommands: vi.fn(),
    cancelAutoApproveCommands: vi.fn(),
    approveCommand: vi.fn(),
    skipCommand: vi.fn(),
    approveFileEdit: vi.fn(),
    skipFileEdit: vi.fn(),
    openFileDiff: vi.fn(),
    autoApproveSensitiveEdits: false,
    toggleAutoApproveSensitiveEdits: vi.fn(),
    autoApproveSensitiveEditsConfirmVisible: false,
    confirmAutoApproveSensitiveEdits: vi.fn(),
    cancelAutoApproveSensitiveEdits: vi.fn(),
    isGenerating: false,
    toggleProgress: vi.fn(),
    actionStatusClass: vi.fn(() => ({})),
    addContext: vi.fn(),
    addContextFromFile: vi.fn(),
    addContextCurrentFile: vi.fn(),
    addContextFromTerminal: vi.fn(),
    removeContext: vi.fn(),
    handleEnter: vi.fn(),
    handleSend: vi.fn(),
    resizeInput: vi.fn(),
    selectMode: vi.fn(),
    selectModel: vi.fn(),
    scrollTargetMessageId: null,
    clearScrollTarget: vi.fn(),
    implicitFile: null,
    implicitSelection: null,
    implicitFileEnabled: true,
    toggleImplicitFile: vi.fn(),
    promoteImplicitFile: vi.fn(),
    pinSelection: vi.fn(),
  };
}

// The composable uses onMounted/onBeforeUnmount, which are no-ops outside a
// component setup context. That's fine — we only need to verify the returned
// interface shape and function definitions.

describe('useChatPage composable', () => {
  it('instantiates without throwing', async () => {
    const { useChatPage } = await import('../../../src/webview/scripts/core/chat/composable');
    const props = createMockProps();
    expect(() => useChatPage(props)).not.toThrow();
  });

  it('returns all expected members', async () => {
    const { useChatPage } = await import('../../../src/webview/scripts/core/chat/composable');
    const props = createMockProps();
    const result = useChatPage(props);

    // All members the ChatPage template uses (destructured from useChatPage)
    const expectedKeys = [
      'localMessagesEl',
      'sessionControlsExpanded',
      'progressStatus',
      'progressStatusClass',
      'handleApproveCommand',
      'handleSkipCommand',
      'handleApproveFileEdit',
      'handleSkipFileEdit',
      'handleOpenFileDiff',
      'onInputText',
      'onModeChange',
      'onModelChange',
    ];

    for (const key of expectedKeys) {
      expect(result, `missing key: ${key}`).toHaveProperty(key);
      expect((result as any)[key], `${key} is undefined`).toBeDefined();
    }
  });

  it('handleOpenFileDiff delegates to props.openFileDiff', async () => {
    const { useChatPage } = await import('../../../src/webview/scripts/core/chat/composable');
    const props = createMockProps();
    const { handleOpenFileDiff } = useChatPage(props);
    handleOpenFileDiff('test-approval-id');
    expect(props.openFileDiff).toHaveBeenCalledWith('test-approval-id');
  });

  it('handleApproveCommand delegates to props.approveCommand', async () => {
    const { useChatPage } = await import('../../../src/webview/scripts/core/chat/composable');
    const props = createMockProps();
    const { handleApproveCommand } = useChatPage(props);
    handleApproveCommand('approval-1', 'npm install');
    expect(props.approveCommand).toHaveBeenCalledWith('approval-1', 'npm install');
  });

  it('handleSkipFileEdit delegates to props.skipFileEdit', async () => {
    const { useChatPage } = await import('../../../src/webview/scripts/core/chat/composable');
    const props = createMockProps();
    const { handleSkipFileEdit } = useChatPage(props);
    handleSkipFileEdit('approval-2');
    expect(props.skipFileEdit).toHaveBeenCalledWith('approval-2');
  });
});
