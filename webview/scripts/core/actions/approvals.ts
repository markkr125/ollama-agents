import { autoApproveCommands, autoApproveConfirmVisible, autoApproveSensitiveEdits, autoApproveSensitiveEditsConfirmVisible, currentSessionId, vscode } from '../state';

export const toggleAutoApproveCommands = () => {
  const nextValue = !autoApproveCommands.value;
  if (nextValue) {
    autoApproveConfirmVisible.value = true;
    return;
  }
  autoApproveConfirmVisible.value = false;
  autoApproveCommands.value = false;
  if (currentSessionId.value) {
    vscode.postMessage({
      type: 'setAutoApprove',
      sessionId: currentSessionId.value,
      enabled: false
    });
  }
};

export const confirmAutoApproveCommands = () => {
  autoApproveConfirmVisible.value = false;
  autoApproveCommands.value = true;
  if (currentSessionId.value) {
    vscode.postMessage({
      type: 'setAutoApprove',
      sessionId: currentSessionId.value,
      enabled: true
    });
  }
};

export const cancelAutoApproveCommands = () => {
  autoApproveConfirmVisible.value = false;
};

export const approveCommand = (approvalId: string, command?: string) => {
  vscode.postMessage({ type: 'toolApprovalResponse', approvalId, approved: true, command });
};

export const skipCommand = (approvalId: string) => {
  vscode.postMessage({ type: 'toolApprovalResponse', approvalId, approved: false });
};

export const toggleAutoApproveSensitiveEdits = () => {
  const nextValue = !autoApproveSensitiveEdits.value;
  if (nextValue) {
    autoApproveSensitiveEditsConfirmVisible.value = true;
    return;
  }
  autoApproveSensitiveEditsConfirmVisible.value = false;
  autoApproveSensitiveEdits.value = false;
  if (currentSessionId.value) {
    vscode.postMessage({
      type: 'setAutoApproveSensitiveEdits',
      sessionId: currentSessionId.value,
      enabled: false
    });
  }
};

export const confirmAutoApproveSensitiveEdits = () => {
  autoApproveSensitiveEditsConfirmVisible.value = false;
  autoApproveSensitiveEdits.value = true;
  if (currentSessionId.value) {
    vscode.postMessage({
      type: 'setAutoApproveSensitiveEdits',
      sessionId: currentSessionId.value,
      enabled: true
    });
  }
};

export const cancelAutoApproveSensitiveEdits = () => {
  autoApproveSensitiveEditsConfirmVisible.value = false;
};

export const approveFileEdit = (approvalId: string) => {
  vscode.postMessage({ type: 'toolApprovalResponse', approvalId, approved: true });
};

export const skipFileEdit = (approvalId: string) => {
  vscode.postMessage({ type: 'toolApprovalResponse', approvalId, approved: false });
};

export const openFileDiff = (approvalId: string) => {
  vscode.postMessage({ type: 'openFileDiff', approvalId });
};
