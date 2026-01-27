import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Execute git command using CLI
 */
export async function execGit(workspaceRoot: string, args: string[]): Promise<string> {
  const command = `git ${args.join(' ')}`;
  
  try {
    const { stdout } = await execAsync(command, { cwd: workspaceRoot });
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Git command failed: ${error.message}`);
  }
}

/**
 * Check if git is installed
 */
export async function isGitInstalled(): Promise<boolean> {
  try {
    await execAsync('git --version');
    return true;
  } catch {
    return false;
  }
}
