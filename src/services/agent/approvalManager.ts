import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// ApprovalManager — tracks pending approval promises for terminal commands
// and file edits. The webview resolves approvals via handleResponse().
// ---------------------------------------------------------------------------

export class ApprovalManager {
  private pendingApprovals = new Map<string, { resolve: (result: { approved: boolean; command?: string }) => void }>();

  /**
   * Register a pending approval and return a promise that resolves when
   * the user approves/rejects (or when the cancellation token fires).
   */
  waitForApproval(
    approvalId: string,
    token: vscode.CancellationToken
  ): Promise<{ approved: boolean; command?: string }> {
    return new Promise(resolve => {
      const onCancel = token.onCancellationRequested(() => {
        onCancel.dispose();
        this.pendingApprovals.delete(approvalId);
        resolve({ approved: false });
      });

      this.pendingApprovals.set(approvalId, {
        resolve: (result: { approved: boolean; command?: string }) => {
          onCancel.dispose();
          resolve(result);
        }
      });
    });
  }

  /**
   * Called when the webview sends an approval/rejection response.
   */
  handleResponse(approvalId: string, approved: boolean, command?: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    pending.resolve({ approved, command });
    this.pendingApprovals.delete(approvalId);
  }
}
