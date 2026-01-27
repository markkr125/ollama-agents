import * as vscode from 'vscode';

export class TokenManager {
  private static readonly TOKEN_KEY = 'ollama-bearer-token';

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Store bearer token securely
   */
  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(TokenManager.TOKEN_KEY, token);
  }

  /**
   * Get stored bearer token
   */
  async getToken(): Promise<string | undefined> {
    return await this.context.secrets.get(TokenManager.TOKEN_KEY);
  }

  /**
   * Delete stored bearer token
   */
  async deleteToken(): Promise<void> {
    await this.context.secrets.delete(TokenManager.TOKEN_KEY);
  }

  /**
   * Check if token exists
   */
  async hasToken(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }

  /**
   * Prompt user for bearer token if not already set
   */
  async ensureToken(force = false): Promise<string | undefined> {
    if (!force) {
      const existing = await this.getToken();
      if (existing) {
        return existing;
      }
    }

    const token = await vscode.window.showInputBox({
      prompt: 'Enter OpenWebUI Bearer Token (leave empty for local Ollama)',
      password: true,
      placeHolder: 'Bearer token (optional)',
      ignoreFocusOut: true
    });

    if (token && token.trim()) {
      await this.setToken(token.trim());
      return token.trim();
    }

    return undefined;
  }

  /**
   * Show token management UI
   */
  async manageToken(): Promise<void> {
    const hasToken = await this.hasToken();
    
    const options = hasToken
      ? ['Update Token', 'Remove Token', 'Cancel']
      : ['Set Token', 'Cancel'];

    const choice = await vscode.window.showQuickPick(options, {
      placeHolder: 'Manage OpenWebUI Bearer Token'
    });

    switch (choice) {
      case 'Set Token':
      case 'Update Token':
        await this.ensureToken(true);
        vscode.window.showInformationMessage('Bearer token updated successfully');
        break;
      case 'Remove Token':
        await this.deleteToken();
        vscode.window.showInformationMessage('Bearer token removed');
        break;
    }
  }
}
