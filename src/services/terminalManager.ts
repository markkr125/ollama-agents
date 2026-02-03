import * as vscode from 'vscode';

export type CommandExecutionResult = {
  command: string;
  cwd: string;
  output: string;
  exitCode: number | null;
};

type TerminalEntry = {
  terminal: vscode.Terminal;
  sessionId: string;
};

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal(terminal => {
        for (const [sessionId, entry] of this.terminals.entries()) {
          if (entry.terminal === terminal) {
            this.terminals.delete(sessionId);
            break;
          }
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.disposables = [];
  }

  getOrCreateTerminal(sessionId: string, cwd: string, title?: string): vscode.Terminal {
    const existing = this.terminals.get(sessionId);
    if (existing && this.isTerminalAlive(existing.terminal)) {
      return existing.terminal;
    }

    const terminal = vscode.window.createTerminal({
      name: title ? `Ollama Copilot: ${title}` : 'Ollama Copilot',
      cwd
    });

    this.terminals.set(sessionId, { terminal, sessionId });
    return terminal;
  }

  async executeCommand(
    sessionId: string,
    command: string,
    cwd: string,
    title?: string
  ): Promise<CommandExecutionResult> {
    const terminal = this.getOrCreateTerminal(sessionId, cwd, title);
    terminal.show(true);

    const shellIntegration = await this.waitForShellIntegration(terminal, 5000);
    if (!shellIntegration) {
      throw new Error(
        'Terminal shell integration is unavailable. Enable terminal.integrated.shellIntegration.enabled and use VS Code 1.93+.'
      );
    }

    const execution = shellIntegration.executeCommand(command);
    let output = '';

    for await (const chunk of execution.read()) {
      output += chunk;
    }

    const exitCode = await this.waitForExecutionEnd(execution);
    const formattedOutput = this.formatOutput(command, output, exitCode);

    return {
      command,
      cwd,
      output: formattedOutput,
      exitCode
    };
  }

  private isTerminalAlive(terminal: vscode.Terminal): boolean {
    return vscode.window.terminals.includes(terminal);
  }

  private waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        disposable.dispose();
        resolve(undefined);
      }, timeoutMs);

      const disposable = vscode.window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(event.shellIntegration);
        }
      });
    });
  }

  private waitForExecutionEnd(
    execution: vscode.TerminalShellExecution
  ): Promise<number | null> {
    return new Promise(resolve => {
      const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.execution === execution) {
          disposable.dispose();
          resolve(typeof event.exitCode === 'number' ? event.exitCode : null);
        }
      });
    });
  }

  private formatOutput(command: string, output: string, exitCode: number | null): string {
    // Strip ANSI escape sequences and VS Code shell integration markers
    const cleanOutput = this.stripAnsiAndShellIntegration(output);
    const trimmedOutput = cleanOutput.trimEnd();
    const lines = trimmedOutput.length > 0 ? trimmedOutput.split('\n') : [];

    const maxLines = 100;
    const headLines = 15;
    const tailLines = 85;

    let truncatedOutput = trimmedOutput;
    if (lines.length > maxLines) {
      const head = lines.slice(0, headLines);
      const tail = lines.slice(lines.length - tailLines);
      const omitted = lines.length - head.length - tail.length;
      truncatedOutput = [...head, `... [${omitted} lines truncated] ...`, ...tail].join('\n');
    }

    const exitLine = `Exit code: ${exitCode ?? 'unknown'}`;
    const outputBody = truncatedOutput ? `${truncatedOutput}\n` : '';

    return `Command: ${command}\n${outputBody}${exitLine}`.trimEnd();
  }

  private stripAnsiAndShellIntegration(text: string): string {
    // Remove ANSI escape sequences (colors, cursor movement, etc.)
    // eslint-disable-next-line no-control-regex
    let cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    
    // Remove OSC (Operating System Command) sequences like ]633;...
    // These are VS Code shell integration markers: ]633;A, ]633;B, ]633;C, ]633;D, etc.
    // eslint-disable-next-line no-control-regex
    cleaned = cleaned.replace(/\x1b\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    
    // Also handle bare OSC sequences without proper escape prefix (sometimes happens)
    cleaned = cleaned.replace(/\]633;[A-Z][^\n]*/g, '');
    
    // Remove any remaining control characters except newlines and tabs
    // eslint-disable-next-line no-control-regex
    cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    
    return cleaned;
  }
}
