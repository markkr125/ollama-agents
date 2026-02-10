import * as vscode from 'vscode';
import { execGit, isGitInstalled } from '../utils/gitCli';

export class GitOperations {
  private gitApiCache: any = null;

  /**
   * Get VS Code Git API if available
   */
  private getGitAPI(): any {
    if (this.gitApiCache !== null) {
      return this.gitApiCache;
    }

    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (gitExtension && gitExtension.isActive) {
        const git = gitExtension.exports;
        if (git && typeof git.getAPI === 'function') {
          this.gitApiCache = git.getAPI(1);
          return this.gitApiCache;
        }
      }
    } catch (_error) {
      console.log('Git API not available, using CLI fallback');
    }

    this.gitApiCache = false;
    return null;
  }

  /**
   * Get workspace root path
   */
  private getWorkspaceRoot(workspace?: vscode.WorkspaceFolder): string {
    const folder = workspace || vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder found');
    }
    return folder.uri.fsPath;
  }

  /**
   * Create a new branch
   */
  async createBranch(baseBranch: string, taskName: string, workspace?: vscode.WorkspaceFolder): Promise<string> {
    const branchName = `ollama-agent/${Date.now()}-${this.sanitizeBranchName(taskName.slice(0, 30))}`;
    const workspaceRoot = this.getWorkspaceRoot(workspace);

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo) {
          await repo.createBranch(branchName, true);
          return branchName;
        }
      }

      // Fallback to CLI
      await execGit(workspaceRoot, ['checkout', '-b', branchName, baseBranch]);
      return branchName;

    } catch (error: any) {
      throw new Error(`Failed to create branch: ${error.message}`);
    }
  }

  /**
   * Stage files
   */
  async stageFiles(paths: string[], workspace?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot(workspace);

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo) {
          await repo.add(paths);
          return;
        }
      }

      // Fallback to CLI
      await execGit(workspaceRoot, ['add', ...paths]);

    } catch (error: any) {
      throw new Error(`Failed to stage files: ${error.message}`);
    }
  }

  /**
   * Commit changes
   */
  async commit(message: string, coAuthor?: string, workspace?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot(workspace);
    let fullMessage = message;

    if (coAuthor) {
      fullMessage += `\n\nCo-authored-by: ${coAuthor}`;
    }

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo) {
          await repo.commit(fullMessage);
          return;
        }
      }

      // Fallback to CLI
      await execGit(workspaceRoot, ['commit', '-m', fullMessage]);

    } catch (error: any) {
      throw new Error(`Failed to commit: ${error.message}`);
    }
  }

  /**
   * Push branch to remote
   */
  async push(remote: string, branch: string, setUpstream: boolean, workspace?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot(workspace);

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo) {
          await repo.push(remote, branch, setUpstream);
          return;
        }
      }

      // Fallback to CLI
      const args = ['push'];
      if (setUpstream) {
        args.push('-u', remote, branch);
      } else {
        args.push(remote, branch);
      }
      
      await execGit(workspaceRoot, args);

    } catch (error: any) {
      throw new Error(`Failed to push: ${error.message}`);
    }
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(workspace?: vscode.WorkspaceFolder): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot(workspace);

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo && repo.state.HEAD) {
          return repo.state.HEAD.name || 'main';
        }
      }

      // Fallback to CLI
      return await execGit(workspaceRoot, ['branch', '--show-current']);

    } catch (error: any) {
      throw new Error(`Failed to get current branch: ${error.message}`);
    }
  }

  /**
   * Get remote URL
   */
  async getRemoteUrl(remote: string = 'origin', workspace?: vscode.WorkspaceFolder): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot(workspace);

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo && repo.state.remotes) {
          const remoteObj = repo.state.remotes.find((r: any) => r.name === remote);
          if (remoteObj && remoteObj.fetchUrl) {
            return remoteObj.fetchUrl;
          }
        }
      }

      // Fallback to CLI
      return await execGit(workspaceRoot, ['config', '--get', `remote.${remote}.url`]);

    } catch (error: any) {
      throw new Error(`Failed to get remote URL: ${error.message}`);
    }
  }

  /**
   * Get repository status
   */
  async getStatus(workspace?: vscode.WorkspaceFolder): Promise<{ hasChanges: boolean; files: string[] }> {
    const workspaceRoot = this.getWorkspaceRoot(workspace);

    try {
      const gitAPI = this.getGitAPI();
      
      if (gitAPI) {
        const repo = gitAPI.repositories[0];
        if (repo) {
          const changes = repo.state.workingTreeChanges || [];
          return {
            hasChanges: changes.length > 0,
            files: changes.map((c: any) => c.uri.fsPath)
          };
        }
      }

      // Fallback to CLI
      const output = await execGit(workspaceRoot, ['status', '--porcelain']);
      const files = output
        .split('\n')
        .filter(line => line.trim())
        .map(line => line.substring(3));

      return {
        hasChanges: files.length > 0,
        files
      };

    } catch (error: any) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  /**
   * Sanitize branch name
   */
  private sanitizeBranchName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Validate Git is available
   */
  async validateGit(): Promise<boolean> {
    const gitAPI = this.getGitAPI();
    if (gitAPI) {
      return true;
    }

    return await isGitInstalled();
  }
}
