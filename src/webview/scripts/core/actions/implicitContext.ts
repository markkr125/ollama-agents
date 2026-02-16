import { contextList, currentMode, implicitFile, implicitFileEnabled, implicitSelection, vscode } from '../state';

/**
 * Toggle the implicit file chip on/off (eye icon in Ask/Edit/Plan modes).
 */
export const toggleImplicitFile = () => {
  implicitFileEnabled.value = !implicitFileEnabled.value;
};

/**
 * Promote the implicit file suggestion to an explicit context item.
 * Used when clicking the faded chip in Agent mode.
 */
export const promoteImplicitFile = () => {
  if (!implicitFile.value) return;
  // Request the backend to send the full file content as an addContextItem
  vscode.postMessage({ type: 'addContextCurrentFile' });
};

/**
 * Pin the current selection to explicit context.
 * Converts the implicit selection chip to a permanent context item.
 */
export const pinSelection = () => {
  if (!implicitSelection.value) return;
  const sel = implicitSelection.value;
  contextList.value.push({
    fileName: `${sel.relativePath || sel.fileName}:L${sel.startLine}-L${sel.endLine}`,
    content: sel.content,
    kind: 'explicit',
    languageId: sel.languageId,
    lineRange: `L${sel.startLine}-L${sel.endLine}`
  });
  // Clear the implicit selection since it's now pinned
  implicitSelection.value = null;
};

/**
 * Get combined context items for sending with a message.
 * Includes explicit items + applicable implicit context based on current mode.
 */
export const getEffectiveContext = (): Array<{ fileName: string; content: string }> => {
  const items: Array<{ fileName: string; content: string }> = [];

  // Always include explicit context
  for (const item of contextList.value) {
    items.push({ fileName: item.fileName, content: item.content });
  }

  // Include implicit selection (always, regardless of mode)
  if (implicitSelection.value) {
    const sel = implicitSelection.value;
    items.push({
      fileName: `${sel.fileName}:L${sel.startLine}-L${sel.endLine}`,
      content: sel.content
    });
  }

  // Include implicit file in non-agent modes (if enabled and not already in explicit)
  if (
    currentMode.value !== 'agent' &&
    implicitFileEnabled.value &&
    implicitFile.value
  ) {
    const isAlreadyExplicit = contextList.value.some(
      c => c.fileName === implicitFile.value?.fileName ||
           c.fileName === implicitFile.value?.relativePath
    );
    if (!isAlreadyExplicit) {
      // We don't have the file content in the webview; request it from backend
      // The backend will include it via the editorContext mechanism
      // For now, add a marker that the backend resolves
      items.push({
        fileName: implicitFile.value.relativePath || implicitFile.value.fileName,
        content: '__implicit_file__'
      });
    }
  }

  return items;
};
