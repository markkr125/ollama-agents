import { autoApproveCommands, autoApproveConfirmVisible, currentSessionId, vscode } from '../state';

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
