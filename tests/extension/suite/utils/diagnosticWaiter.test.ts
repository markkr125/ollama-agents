import * as assert from 'assert';
import * as vscode from 'vscode';
import { formatDiagnostics, getErrorDiagnostics } from '../../../../src/utils/diagnosticWaiter';

/**
 * Tests for diagnosticWaiter utility — formatting and filtering functions.
 *
 * waitForDiagnostics() is not tested here as it depends on real LSP responses
 * and onDidChangeDiagnostics events, which require a live workspace.
 */

// ─── Helpers ─────────────────────────────────────────────────────────

function makeDiagnostic(
  line: number,
  message: string,
  severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error
): vscode.Diagnostic {
  const range = new vscode.Range(line, 0, line, 10);
  return new vscode.Diagnostic(range, message, severity);
}

// ─── Tests ───────────────────────────────────────────────────────────

suite('diagnosticWaiter', () => {

  // ── formatDiagnostics ──────────────────────────────────────────

  suite('formatDiagnostics', () => {
    test('returns empty string for empty array', () => {
      assert.strictEqual(formatDiagnostics([]), '');
    });

    test('formats single error diagnostic', () => {
      const diags = [makeDiagnostic(5, 'Cannot find name "foo"', vscode.DiagnosticSeverity.Error)];
      const result = formatDiagnostics(diags);
      assert.ok(result.includes('Line 6'), 'Should show 1-indexed line number');
      assert.ok(result.includes('[Error]'), 'Should show severity');
      assert.ok(result.includes('Cannot find name "foo"'), 'Should show message');
    });

    test('formats multiple diagnostics sorted by severity', () => {
      const diags = [
        makeDiagnostic(10, 'warning msg', vscode.DiagnosticSeverity.Warning),
        makeDiagnostic(5, 'error msg', vscode.DiagnosticSeverity.Error),
        makeDiagnostic(15, 'info msg', vscode.DiagnosticSeverity.Information),
      ];
      const result = formatDiagnostics(diags);
      const lines = result.split('\n');
      assert.strictEqual(lines.length, 3);
      assert.ok(lines[0].includes('[Error]'), 'Errors should come first');
      assert.ok(lines[1].includes('[Warning]'), 'Warnings should come second');
      assert.ok(lines[2].includes('[Info]'), 'Info should come third');
    });

    test('truncates to maxItems and shows overflow count', () => {
      const diags = Array.from({ length: 20 }, (_, i) =>
        makeDiagnostic(i, `error ${i}`, vscode.DiagnosticSeverity.Error)
      );
      const result = formatDiagnostics(diags, 5);
      const lines = result.split('\n');
      assert.strictEqual(lines.length, 6, 'Should have 5 items + 1 overflow line');
      assert.ok(lines[5].includes('15 more'), 'Should show remaining count');
    });

    test('respects custom maxItems', () => {
      const diags = Array.from({ length: 3 }, (_, i) =>
        makeDiagnostic(i, `error ${i}`, vscode.DiagnosticSeverity.Error)
      );
      const result = formatDiagnostics(diags, 2);
      const lines = result.split('\n');
      assert.strictEqual(lines.length, 3, 'Should have 2 items + 1 overflow');
      assert.ok(lines[2].includes('1 more'), 'Should show remaining count');
    });
  });

  // ── getErrorDiagnostics ────────────────────────────────────────

  suite('getErrorDiagnostics', () => {
    test('returns empty array for no diagnostics', () => {
      const result = getErrorDiagnostics([]);
      assert.strictEqual(result.length, 0);
    });

    test('filters to Error severity only', () => {
      const diags = [
        makeDiagnostic(1, 'error', vscode.DiagnosticSeverity.Error),
        makeDiagnostic(2, 'warning', vscode.DiagnosticSeverity.Warning),
        makeDiagnostic(3, 'info', vscode.DiagnosticSeverity.Information),
        makeDiagnostic(4, 'hint', vscode.DiagnosticSeverity.Hint),
        makeDiagnostic(5, 'error2', vscode.DiagnosticSeverity.Error),
      ];
      const result = getErrorDiagnostics(diags);
      assert.strictEqual(result.length, 2, 'Should only return Error severity');
      assert.ok(result.every(d => d.severity === vscode.DiagnosticSeverity.Error));
    });

    test('returns all when all are errors', () => {
      const diags = [
        makeDiagnostic(1, 'err1', vscode.DiagnosticSeverity.Error),
        makeDiagnostic(2, 'err2', vscode.DiagnosticSeverity.Error),
      ];
      const result = getErrorDiagnostics(diags);
      assert.strictEqual(result.length, 2);
    });
  });
});
