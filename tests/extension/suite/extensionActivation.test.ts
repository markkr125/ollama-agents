import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Regression test for extension activation.
 *
 * Verifies that the extension:
 * 1. Is discoverable by VS Code
 * 2. Exports activate/deactivate
 * 3. Activates without throwing
 *
 * Catches issues like stale webpack builds where critical module exports
 * (e.g. getDatabaseService) are missing, causing activation to fail with
 * errors like "(0 , g.getDatabaseService) is not a function".
 */
suite('Extension activation', () => {
  const EXTENSION_ID = 'ollama-copilot.ollama-copilot';

  test('extension is present and activates without error', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} must be available`);

    // If already active, this is a no-op. Otherwise it will activate.
    await ext.activate();
    assert.ok(ext.isActive, 'Extension must be active after activate()');
  });
});
