import * as assert from 'assert';
import { computeTerminalApprovalDecision } from '../../../../src/utils/terminalApproval';

suite('computeTerminalApprovalDecision', () => {
  test('requires approval when severity is critical (even if auto-approve enabled)', () => {
    const decision = computeTerminalApprovalDecision(
      { severity: 'critical', reason: 'Recursive or forced deletion' },
      true
    );

    assert.deepStrictEqual(decision, {
      requiresApproval: true,
      severity: 'critical',
      reason: 'Recursive or forced deletion'
    });
  });

  test('requires approval when auto-approve disabled, even for safe commands', () => {
    const decision = computeTerminalApprovalDecision({ severity: 'none' }, false);

    assert.deepStrictEqual(decision, {
      requiresApproval: true,
      severity: 'medium',
      reason: 'Command requires approval'
    });
  });

  test('does not require approval when auto-approve enabled and severity is none', () => {
    const decision = computeTerminalApprovalDecision({ severity: 'none' }, true);

    assert.deepStrictEqual(decision, {
      requiresApproval: false,
      severity: 'medium',
      reason: 'Command requires approval'
    });
  });

  test('does not require approval when auto-approve enabled and severity is medium', () => {
    const decision = computeTerminalApprovalDecision(
      { severity: 'medium', reason: 'Destructive git operation' },
      true
    );

    assert.deepStrictEqual(decision, {
      requiresApproval: false,
      severity: 'medium',
      reason: 'Destructive git operation'
    });
  });

  test('does not require approval when auto-approve enabled and severity is high', () => {
    const decision = computeTerminalApprovalDecision(
      { severity: 'high', reason: 'Privilege escalation' },
      true
    );

    assert.deepStrictEqual(decision, {
      requiresApproval: false,
      severity: 'high',
      reason: 'Privilege escalation'
    });
  });
});
