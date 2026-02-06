import * as assert from 'assert';
import * as databaseServiceModule from '../../../services/databaseService';

/**
 * Regression test for: "Ollama Copilot activation failed: (0, g.getDatabaseService) is not a function"
 *
 * This error occurs when the webpack bundle's databaseService module fails to
 * export `getDatabaseService` (e.g. stale build, tree-shaking issue, or module
 * evaluation error).  The test verifies that every public export the extension
 * relies on is present and has the correct type.
 */
suite('databaseService module exports', () => {
  test('getDatabaseService is an exported function', () => {
    assert.strictEqual(
      typeof databaseServiceModule.getDatabaseService,
      'function',
      'getDatabaseService must be exported as a function'
    );
  });

  test('disposeDatabaseService is an exported function', () => {
    assert.strictEqual(
      typeof databaseServiceModule.disposeDatabaseService,
      'function',
      'disposeDatabaseService must be exported as a function'
    );
  });

  test('DatabaseService is an exported constructor', () => {
    assert.strictEqual(
      typeof databaseServiceModule.DatabaseService,
      'function',
      'DatabaseService must be exported as a constructor/class'
    );
  });
});
