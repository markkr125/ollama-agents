import * as assert from 'assert';
import { getConfig, getModeConfig } from '../../../../src/config/settings';

/**
 * Tests for settings.ts — mode configs.
 *
 * These tests verify that getConfig() returns the expected default values
 * for the mode configurations and that getModeConfig() dispatches correctly.
 * Runs in the extension host with VS Code APIs available.
 */

suite('settings – mode configs', () => {
  // ── getConfig defaults ──────────────────────────────────────────

  test('getConfig returns chatMode with expected defaults', () => {
    const config = getConfig();
    assert.ok(config.chatMode, 'chatMode should exist');
    assert.strictEqual(typeof config.chatMode.model, 'string', 'model should be string');
    assert.strictEqual(config.chatMode.temperature, 0.7, 'Default temperature should be 0.7');
    assert.strictEqual(config.chatMode.maxTokens, 2048, 'Default maxTokens should be 2048');
  });

  // ── getModeConfig dispatch ──────────────────────────────────────

  test('getModeConfig("chat") returns chatMode config', () => {
    const modeConfig = getModeConfig('chat');
    const fullConfig = getConfig();
    assert.deepStrictEqual(modeConfig, fullConfig.chatMode, 'Should match chatMode');
  });

  test('getModeConfig("plan") returns planMode config', () => {
    const modeConfig = getModeConfig('plan');
    const fullConfig = getConfig();
    assert.deepStrictEqual(modeConfig, fullConfig.planMode, 'Should match planMode');
  });

  test('getModeConfig("agent") returns agentMode config', () => {
    const modeConfig = getModeConfig('agent');
    const fullConfig = getConfig();
    assert.deepStrictEqual(modeConfig, fullConfig.agentMode, 'Should match agentMode');
  });
});
