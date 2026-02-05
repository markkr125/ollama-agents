import { autoApproveCommands, autoApproveConfirmVisible, autoApproveSensitiveEdits, currentSessionId, vscode } from '../state';

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
  autoApproveSensitiveEdits.value = !autoApproveSensitiveEdits.value;
  if (currentSessionId.value) {
    vscode.postMessage({
      type: 'setAutoApproveSensitiveEdits',
      sessionId: currentSessionId.value,
      enabled: autoApproveSensitiveEdits.value
    });
  }
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
