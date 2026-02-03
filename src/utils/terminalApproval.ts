import { CommandSeverity } from './commandSafety';

export type TerminalApprovalSeverity = Exclude<CommandSeverity, 'none'>;

export type DangerousCommandAnalysisLike = {
  severity: CommandSeverity;
  reason?: string;
};

export type TerminalApprovalDecision = {
  /** True if user interaction is required before execution. */
  requiresApproval: boolean;
  /** Severity presented to the user in the approval UI (never 'none'). */
  severity: TerminalApprovalSeverity;
  /** Human-readable reason shown in the approval UI. */
  reason: string;
};

/**
 * Centralizes the approval decision policy for terminal commands.
 * Kept as a pure function so tests remain stable even if tool execution changes later.
 */
export function computeTerminalApprovalDecision(
  analysis: DangerousCommandAnalysisLike,
  autoApproveEnabled: boolean
): TerminalApprovalDecision {
  const requiresApproval = analysis.severity === 'critical' || !autoApproveEnabled;
  const severity: TerminalApprovalSeverity = analysis.severity === 'none' ? 'medium' : analysis.severity;
  const reason = analysis.reason || 'Command requires approval';

  return { requiresApproval, severity, reason };
}
