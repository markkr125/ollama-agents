import * as assert from 'assert';
import * as vscode from 'vscode';
import { AgentDispatcher } from '../../../../src/agent/execution/orchestration/agentDispatcher';
import { OllamaClient } from '../../../../src/services/model/ollamaClient';

/**
 * Tests for AgentDispatcher — LLM-based intent classification.
 *
 * Since the dispatcher relies on an LLM call, these tests focus on:
 *   1. Fallback behavior when the LLM is unreachable (default to mixed)
 *   2. Constructor and public API shape
 */
suite('AgentDispatcher', () => {
  let dispatcher: AgentDispatcher;
  let outputChannel: vscode.OutputChannel;

  suiteSetup(() => {
    outputChannel = vscode.window.createOutputChannel('Test Dispatcher', { log: true });
    // Client points at a non-existent server — all LLM calls will fail,
    // exercising the fallback path.
    const client = new OllamaClient('http://localhost:99999');
    dispatcher = new AgentDispatcher(client, outputChannel);
  });

  suiteTeardown(() => {
    outputChannel.dispose();
  });

  // =========================================================================
  // Fallback behavior — LLM unreachable → defaults to mixed
  // =========================================================================

  suite('fallback when LLM is unreachable', () => {
    test('returns mixed intent with confidence 0 when LLM fails', async () => {
      const result = await dispatcher.classify('explain all functions in this file', 'nonexistent-model');
      assert.strictEqual(result.intent, 'mixed');
      assert.strictEqual(result.needsWrite, true);
      assert.strictEqual(result.confidence, 0);
    });

    test('includes reasoning about failure', async () => {
      const result = await dispatcher.classify('fix the bug', 'nonexistent-model');
      assert.ok(result.reasoning.length > 0, 'reasoning should not be empty');
    });
  });

  // =========================================================================
  // API shape
  // =========================================================================

  suite('API', () => {
    test('classify returns a DispatchResult', async () => {
      const result = await dispatcher.classify('hello', 'test-model');
      assert.ok('intent' in result);
      assert.ok('needsWrite' in result);
      assert.ok('confidence' in result);
      assert.ok('reasoning' in result);
    });

    test('intent is one of the valid TaskIntent values', async () => {
      const result = await dispatcher.classify('do something', 'test-model');
      assert.ok(
        ['analyze', 'modify', 'create', 'mixed'].includes(result.intent),
        `Unexpected intent: ${result.intent}`
      );
    });
  });
});
