import { contextList, currentSessionId, inputEl, inputText, isGenerating, vscode } from '../state';
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

  const safeContext = contextList.value.map(item => ({
    fileName: item.fileName,
    content: item.content
  }));
  vscode.postMessage({ type: 'sendMessage', text, context: safeContext });
  inputText.value = '';
  resizeInput(inputEl.value);
  contextList.value = [];
};

export const removeContext = (index: number) => {
  contextList.value.splice(index, 1);
};

export const resizeInputField = () => {
  resizeInput(inputEl.value);
};
