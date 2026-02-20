import { nextTick } from 'vue';
import { contextList, currentMode, currentSessionId, implicitFile, implicitFileEnabled, implicitSelection, inputEl, inputText, isGenerating, vscode } from '../state';
import { resizeInput } from './scroll';

export const handleEnter = () => {
  if (!isGenerating.value) {
    handleSend();
  }
};

export const handleSend = () => {
  if (isGenerating.value) {
    vscode.postMessage({ type: 'stopGeneration', sessionId: currentSessionId.value });
    return;
  }

  const text = inputText.value.trim();
  if (!text) return;

  // Build context: explicit items + applicable implicit context
  const safeContext: Array<{ fileName: string; content: string; kind?: string; lineRange?: string }> = [];

  // Explicit context
  for (const item of contextList.value) {
    safeContext.push({ fileName: item.fileName, content: item.content, kind: item.kind || 'explicit', lineRange: item.lineRange });
  }

  // Implicit selection (always included, regardless of mode)
  if (implicitSelection.value) {
    const sel = implicitSelection.value;
    const lineRange = `L${sel.startLine}-L${sel.endLine}`;
    safeContext.push({
      fileName: `${sel.relativePath || sel.fileName}:${lineRange}`,
      content: sel.content,
      kind: 'implicit-selection',
      lineRange
    });
  }

  // Implicit file in non-agent modes (if enabled and not already explicit)
  if (
    currentMode.value !== 'agent' &&
    implicitFileEnabled.value &&
    implicitFile.value &&
    !contextList.value.some(c =>
      c.fileName === implicitFile.value?.fileName ||
      c.fileName === implicitFile.value?.relativePath
    )
  ) {
    safeContext.push({
      fileName: implicitFile.value.relativePath || implicitFile.value.fileName,
      content: '__implicit_file__',
      kind: 'implicit-file'
    });
  }

  vscode.postMessage({ type: 'sendMessage', text, context: safeContext });
  inputText.value = '';
  nextTick(() => resizeInput(inputEl.value));
  contextList.value = [];
};

export const removeContext = (index: number) => {
  contextList.value.splice(index, 1);
};

export const resizeInputField = () => {
  resizeInput(inputEl.value);
};
