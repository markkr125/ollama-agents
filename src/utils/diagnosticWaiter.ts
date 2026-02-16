import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// diagnosticWaiter — waits for VS Code's language service to produce fresh
// diagnostics for a specific file URI. Uses onDidChangeDiagnostics to avoid
// polling, with a timeout fallback for slow LSP servers or high CPU/disk load.
// ---------------------------------------------------------------------------

/**
 * Wait for diagnostics to stabilize on the given URI.
 *
 * Subscribes to `vscode.languages.onDidChangeDiagnostics` and resolves
 * once the target URI appears in a change event, or when the timeout fires.
 *
 * @param uri      Target file URI
 * @param timeoutMs  Maximum wait in ms (default 3000). Use 0 for no timeout.
 * @returns The diagnostics for the URI (may be empty if none)
 */
export function waitForDiagnostics(
  uri: vscode.Uri,
  timeoutMs = 3000
): Promise<vscode.Diagnostic[]> {
  return new Promise<vscode.Diagnostic[]>((resolve) => {
    const targetPath = uri.fsPath;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      disposable.dispose();
      if (timer) clearTimeout(timer);
      resolve(vscode.languages.getDiagnostics(uri));
    };

    // Listen for diagnostic changes
    const disposable = vscode.languages.onDidChangeDiagnostics((event) => {
      for (const changedUri of event.uris) {
        if (changedUri.fsPath === targetPath) {
          finish();
          return;
        }
      }
    });

    // Timeout fallback — resolve with whatever diagnostics exist at that point
    const timer = timeoutMs > 0 ? setTimeout(finish, timeoutMs) : null;

    // If diagnostics already exist (e.g. file was already open), resolve immediately
    // but give the LSP a short grace period (50ms) to process the new content
    setTimeout(() => {
      if (!settled) {
        const existing = vscode.languages.getDiagnostics(uri);
        // Only resolve early if there ARE diagnostics (errors present)
        // If empty, keep waiting — the LSP might not have processed yet
        if (existing.length > 0) {
          finish();
        }
      }
    }, 50);
  });
}

/**
 * Format diagnostics into a human-readable string for injection into tool results.
 *
 * @param diagnostics  Array of VS Code diagnostics
 * @param maxItems     Maximum number to include (default 15)
 * @returns Formatted string or empty string if no diagnostics
 */
export function formatDiagnostics(
  diagnostics: vscode.Diagnostic[],
  maxItems = 15
): string {
  if (diagnostics.length === 0) return '';

  const severityMap: Record<number, string> = {
    [vscode.DiagnosticSeverity.Error]: 'Error',
    [vscode.DiagnosticSeverity.Warning]: 'Warning',
    [vscode.DiagnosticSeverity.Information]: 'Info',
    [vscode.DiagnosticSeverity.Hint]: 'Hint',
  };

  // Sort by severity (errors first)
  const sorted = [...diagnostics].sort((a, b) => a.severity - b.severity);
  const limited = sorted.slice(0, maxItems);

  const lines = limited.map(d => {
    const sev = severityMap[d.severity] ?? 'Unknown';
    return `Line ${d.range.start.line + 1}: [${sev}] ${d.message}`;
  });

  if (diagnostics.length > maxItems) {
    lines.push(`... and ${diagnostics.length - maxItems} more issues`);
  }

  return lines.join('\n');
}

/**
 * Get only Error-severity diagnostics.
 */
export function getErrorDiagnostics(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
  return diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
}
