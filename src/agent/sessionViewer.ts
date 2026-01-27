import * as vscode from 'vscode';
import { Session } from '../types/session';
import { SessionManager } from './sessionManager';

export class SessionViewProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): vscode.ProviderResult<SessionTreeItem[]> {
    if (!element) {
      // Root level - show all sessions
      const sessions = this.sessionManager.getAllSessions();
      return sessions.map(s => new SessionTreeItem(s, this.sessionManager));
    }

    // Session details
    return element.getChildren();
  }
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public session: Session,
    private sessionManager: SessionManager,
    private isDetail: boolean = false,
    label?: string
  ) {
    super(
      label || SessionTreeItem.getLabel(session),
      isDetail ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
    );

    if (!isDetail) {
      this.iconPath = SessionTreeItem.getIcon(session.status);
      this.contextValue = 'session';
      this.tooltip = this.sessionManager.getSessionSummary(session.id);
    }
  }

  getChildren(): SessionTreeItem[] {
    if (this.isDetail) {
      return [];
    }

    const items: SessionTreeItem[] = [];

    items.push(new SessionTreeItem(this.session, this.sessionManager, true, `Model: ${this.session.model}`));
    items.push(new SessionTreeItem(this.session, this.sessionManager, true, `Status: ${this.session.status}`));
    
    if (this.session.branch) {
      items.push(new SessionTreeItem(this.session, this.sessionManager, true, `Branch: ${this.session.branch}`));
    }

    if (this.session.filesChanged.length > 0) {
      items.push(new SessionTreeItem(
        this.session,
        this.sessionManager,
        true,
        `Files: ${this.session.filesChanged.length} changed`
      ));
    }

    if (this.session.toolCalls.length > 0) {
      items.push(new SessionTreeItem(
        this.session,
        this.sessionManager,
        true,
        `Tools: ${this.session.toolCalls.length} calls`
      ));
    }

    if (this.session.errors.length > 0) {
      items.push(new SessionTreeItem(
        this.session,
        this.sessionManager,
        true,
        `Errors: ${this.session.errors.length}`
      ));
    }

    return items;
  }

  private static getLabel(session: Session): string {
    const truncated = session.task.length > 50
      ? session.task.substring(0, 50) + '...'
      : session.task;
    return truncated;
  }

  private static getIcon(status: Session['status']): vscode.ThemeIcon {
    switch (status) {
      case 'executing':
        return new vscode.ThemeIcon('loading~spin');
      case 'completed':
        return new vscode.ThemeIcon('check');
      case 'failed':
        return new vscode.ThemeIcon('error');
      case 'cancelled':
        return new vscode.ThemeIcon('circle-slash');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }
}

/**
 * Register session viewer
 */
export function registerSessionViewer(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager
): SessionViewProvider {
  const provider = new SessionViewProvider(sessionManager);
  
  const treeView = vscode.window.createTreeView('ollamaCopilot.sessionView', {
    treeDataProvider: provider
  });

  const refreshCommand = vscode.commands.registerCommand(
    'ollamaCopilot.refreshSessions',
    () => provider.refresh()
  );

  const deleteSessionCommand = vscode.commands.registerCommand(
    'ollamaCopilot.deleteSession',
    (item: SessionTreeItem) => {
      if (item && item.session) {
        sessionManager.deleteSession(item.session.id);
        provider.refresh();
      }
    }
  );

  const clearCompletedCommand = vscode.commands.registerCommand(
    'ollamaCopilot.clearCompletedSessions',
    () => {
      sessionManager.clearCompleted();
      provider.refresh();
      vscode.window.showInformationMessage('Completed sessions cleared');
    }
  );

  context.subscriptions.push(treeView, refreshCommand, deleteSessionCommand, clearCompletedCommand);

  return provider;
}
