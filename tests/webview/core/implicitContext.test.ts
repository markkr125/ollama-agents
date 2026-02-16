import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

// --- implicitContext actions ---

describe('toggleImplicitFile', () => {
  test('toggles implicitFileEnabled on/off', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { toggleImplicitFile } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    expect(state.implicitFileEnabled.value).toBe(true);

    toggleImplicitFile();
    expect(state.implicitFileEnabled.value).toBe(false);

    toggleImplicitFile();
    expect(state.implicitFileEnabled.value).toBe(true);
  });
});

describe('promoteImplicitFile', () => {
  test('posts addContextCurrentFile when implicit file exists', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { promoteImplicitFile } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };

    promoteImplicitFile();
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'addContextCurrentFile' });
  });

  test('no-op when implicit file is null', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { promoteImplicitFile } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.implicitFile.value = null;

    promoteImplicitFile();
    expect(vscodePostMessage).not.toHaveBeenCalled();
  });
});

describe('pinSelection', () => {
  test('moves implicit selection to explicit contextList', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { pinSelection } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.implicitSelection.value = {
      fileName: 'app.ts',
      content: 'const x = 1;',
      startLine: 10,
      endLine: 12,
      languageId: 'typescript'
    };
    state.contextList.value = [];

    pinSelection();

    expect(state.contextList.value).toHaveLength(1);
    expect(state.contextList.value[0]).toEqual({
      fileName: 'app.ts:L10-L12',
      content: 'const x = 1;',
      kind: 'explicit',
      languageId: 'typescript',
      lineRange: 'L10-L12'
    });
    // Implicit selection cleared after pinning
    expect(state.implicitSelection.value).toBeNull();
  });

  test('no-op when no implicit selection', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { pinSelection } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.implicitSelection.value = null;
    state.contextList.value = [];

    pinSelection();
    expect(state.contextList.value).toHaveLength(0);
  });
});

describe('getEffectiveContext', () => {
  test('returns only explicit context when no implicit data', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [{ fileName: 'a.ts', content: 'code' }];
    state.implicitFile.value = null;
    state.implicitSelection.value = null;

    const result = getEffectiveContext();
    expect(result).toEqual([{ fileName: 'a.ts', content: 'code' }]);
  });

  test('always includes implicit selection regardless of mode', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [];
    state.currentMode.value = 'agent';
    state.implicitSelection.value = {
      fileName: 'app.ts',
      content: 'selected code',
      startLine: 5,
      endLine: 10,
      languageId: 'typescript'
    };
    state.implicitFile.value = null;

    const result = getEffectiveContext();
    expect(result).toEqual([
      { fileName: 'app.ts:L5-L10', content: 'selected code' }
    ]);
  });

  test('includes implicit file in non-agent modes with __implicit_file__ marker', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    const result = getEffectiveContext();
    expect(result).toEqual([
      { fileName: 'app.ts', content: '__implicit_file__' }
    ]);
  });

  test('excludes implicit file in agent mode', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [];
    state.currentMode.value = 'agent';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    const result = getEffectiveContext();
    expect(result).toEqual([]);
  });

  test('excludes implicit file when disabled', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = false;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    const result = getEffectiveContext();
    expect(result).toEqual([]);
  });

  test('deduplicates: skips implicit file when already in explicit context', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [{ fileName: 'app.ts', content: 'full file' }];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    const result = getEffectiveContext();
    // Only the explicit item, not the implicit file duplicate
    expect(result).toEqual([{ fileName: 'app.ts', content: 'full file' }]);
  });

  test('deduplicates: skips implicit file when explicit uses relativePath format', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    // Backend addContextCurrentFile sends relativePath ("demo-project/app.ts")
    // while EditorContextTracker sends basename as fileName ("app.ts")
    state.contextList.value = [{ fileName: 'demo-project/app.ts', content: 'full file' }];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/demo-project/app.ts', relativePath: 'demo-project/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    const result = getEffectiveContext();
    expect(result).toEqual([{ fileName: 'demo-project/app.ts', content: 'full file' }]);
  });

  test('combines explicit + selection + implicit file correctly', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { getEffectiveContext } = await import('../../../src/webview/scripts/core/actions/implicitContext');

    state.contextList.value = [{ fileName: 'utils.ts', content: 'helper' }];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = {
      fileName: 'app.ts',
      content: 'selected',
      startLine: 1,
      endLine: 3,
      languageId: 'typescript'
    };

    const result = getEffectiveContext();
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ fileName: 'utils.ts', content: 'helper' });
    expect(result[1]).toEqual({ fileName: 'app.ts:L1-L3', content: 'selected' });
    expect(result[2]).toEqual({ fileName: 'app.ts', content: '__implicit_file__' });
  });
});

// --- handleEditorContext message handler ---

describe('handleEditorContext', () => {
  test('sets implicit file and selection from message', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleEditorContext } = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    handleEditorContext({
      type: 'editorContext',
      activeFile: { fileName: 'main.ts', filePath: '/src/main.ts', languageId: 'typescript' },
      activeSelection: { fileName: 'main.ts', content: 'code', startLine: 1, endLine: 5, languageId: 'typescript' }
    });

    expect(state.implicitFile.value).toEqual({ fileName: 'main.ts', filePath: '/src/main.ts', languageId: 'typescript' });
    expect(state.implicitSelection.value).toEqual({ fileName: 'main.ts', content: 'code', startLine: 1, endLine: 5, languageId: 'typescript' });
  });

  test('clears state when no editor is active', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleEditorContext } = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    state.implicitFile.value = { fileName: 'old.ts', filePath: '/old.ts', languageId: 'typescript' };
    state.implicitSelection.value = { fileName: 'old.ts', content: 'x', startLine: 1, endLine: 1, languageId: 'typescript' };

    handleEditorContext({ type: 'editorContext', activeFile: null, activeSelection: null });

    expect(state.implicitFile.value).toBeNull();
    expect(state.implicitSelection.value).toBeNull();
  });

  test('handles file with no selection', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const { handleEditorContext } = await import('../../../src/webview/scripts/core/messageHandlers/sessions');

    handleEditorContext({
      type: 'editorContext',
      activeFile: { fileName: 'util.ts', filePath: '/src/util.ts', languageId: 'typescript' },
      activeSelection: null
    });

    expect(state.implicitFile.value).toEqual({ fileName: 'util.ts', filePath: '/src/util.ts', languageId: 'typescript' });
    expect(state.implicitSelection.value).toBeNull();
  });
});

// --- handleSend includes implicit context ---

describe('handleSend includes implicit context', () => {
  test('includes implicit selection in agent mode', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const actions = await import('../../../src/webview/scripts/core/actions/index');

    state.isGenerating.value = false;
    state.currentSessionId.value = 's1';
    state.inputText.value = 'hello';
    state.contextList.value = [];
    state.currentMode.value = 'agent';
    state.implicitSelection.value = {
      fileName: 'app.ts',
      content: 'selected code',
      startLine: 5,
      endLine: 10,
      languageId: 'typescript'
    };
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };

    actions.handleSend();

    expect(vscodePostMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      text: 'hello',
      context: [
        { fileName: 'app.ts:L5-L10', content: 'selected code', kind: 'implicit-selection', lineRange: 'L5-L10' }
        // No implicit file in agent mode
      ]
    });
  });

  test('includes implicit file with marker in ask mode', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const actions = await import('../../../src/webview/scripts/core/actions/index');

    state.isGenerating.value = false;
    state.currentSessionId.value = 's1';
    state.inputText.value = 'explain this';
    state.contextList.value = [];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    actions.handleSend();

    expect(vscodePostMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      text: 'explain this',
      context: [
        { fileName: 'app.ts', content: '__implicit_file__', kind: 'implicit-file' }
      ]
    });
  });

  test('does not duplicate file when already in explicit context', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const actions = await import('../../../src/webview/scripts/core/actions/index');

    state.isGenerating.value = false;
    state.currentSessionId.value = 's1';
    state.inputText.value = 'analyze';
    state.contextList.value = [{ fileName: 'app.ts', content: 'full content' }];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/src/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    actions.handleSend();

    expect(vscodePostMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      text: 'analyze',
      context: [
        { fileName: 'app.ts', content: 'full content', kind: 'explicit', lineRange: undefined }
        // No duplicate implicit file
      ]
    });
  });

  test('does not duplicate file when explicit uses relativePath format', async () => {
    const state = await import('../../../src/webview/scripts/core/state');
    const actions = await import('../../../src/webview/scripts/core/actions/index');

    state.isGenerating.value = false;
    state.currentSessionId.value = 's1';
    state.inputText.value = 'analyze';
    state.contextList.value = [{ fileName: 'demo-project/app.ts', content: 'full content' }];
    state.currentMode.value = 'chat';
    state.implicitFileEnabled.value = true;
    state.implicitFile.value = { fileName: 'app.ts', filePath: '/demo-project/app.ts', relativePath: 'demo-project/app.ts', languageId: 'typescript' };
    state.implicitSelection.value = null;

    actions.handleSend();

    expect(vscodePostMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      text: 'analyze',
      context: [
        { fileName: 'demo-project/app.ts', content: 'full content', kind: 'explicit', lineRange: undefined }
        // No duplicate implicit file — relativePath match
      ]
    });
  });
});

// --- addContext actions post correct messages ---

describe('addContext source actions', () => {
  test('addContextFromFile posts correct message', async () => {
    const { addContextFromFile } = await import('../../../src/webview/scripts/core/actions/sessions');
    addContextFromFile();
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'addContextFromFile' });
  });

  test('addContextCurrentFile posts correct message', async () => {
    const { addContextCurrentFile } = await import('../../../src/webview/scripts/core/actions/sessions');
    addContextCurrentFile();
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'addContextCurrentFile' });
  });

  test('addContextFromTerminal posts correct message', async () => {
    const { addContextFromTerminal } = await import('../../../src/webview/scripts/core/actions/sessions');
    addContextFromTerminal();
    expect(vscodePostMessage).toHaveBeenCalledWith({ type: 'addContextFromTerminal' });
  });
});
