import * as assert from 'assert';
import { getConfig, getModeConfig } from '../../../../src/config/settings';

/**
 * Tests for settings.ts — new explore/review mode configs.
 *
 * These tests verify that getConfig() returns the expected default values
 * for the new mode configurations and that getModeConfig() dispatches correctly.
 * Runs in the extension host with VS Code APIs available.
 */

suite('settings – new mode configs', () => {
  // ── getConfig defaults ──────────────────────────────────────────

  test('getConfig returns exploreMode with expected defaults', () => {
    const config = getConfig();
    assert.ok(config.exploreMode, 'exploreMode should exist');
    assert.strictEqual(typeof config.exploreMode.model, 'string', 'model should be string');
    assert.strictEqual(config.exploreMode.temperature, 0.5, 'Default temperature should be 0.5');
    assert.strictEqual(config.exploreMode.maxTokens, 4096, 'Default maxTokens should be 4096');
  });

  test('getConfig returns reviewMode with expected defaults', () => {
    const config = getConfig();
    assert.ok(config.reviewMode, 'reviewMode should exist');
    assert.strictEqual(typeof config.reviewMode.model, 'string', 'model should be string');
    assert.strictEqual(config.reviewMode.temperature, 0.3, 'Default temperature should be 0.3');
    assert.strictEqual(config.reviewMode.maxTokens, 4096, 'Default maxTokens should be 4096');
  });

  // ── getModeConfig dispatch ──────────────────────────────────────

  test('getModeConfig("explore") returns exploreMode config', () => {
    const modeConfig = getModeConfig('explore');
    const fullConfig = getConfig();
    assert.deepStrictEqual(modeConfig, fullConfig.exploreMode, 'Should match exploreMode');
  });

  test('getModeConfig("review") returns reviewMode config', () => {
    const modeConfig = getModeConfig('review');
    const fullConfig = getConfig();
    assert.deepStrictEqual(modeConfig, fullConfig.reviewMode, 'Should match reviewMode');
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
