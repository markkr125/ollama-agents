export type CommandSeverity = 'critical' | 'high' | 'medium' | 'none';
export type CommandPlatform = 'linux' | 'darwin' | 'win32' | 'all';

export type CommandSafetyMatch = {
  severity: Exclude<CommandSeverity, 'none'>;
  reason: string;
  pattern: RegExp;
  platforms: CommandPlatform[];
};

const patterns: CommandSafetyMatch[] = [
  // Critical - destructive
  {
    severity: 'critical',
    reason: 'Recursive or forced deletion',
    pattern: /\brm\s+(-[^\n]*r[^\n]*f|--recursive|--force)\b/i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'critical',
    reason: 'Recursive deletion (Windows)',
    pattern: /\b(Remove-Item|ri|del|rd|rmdir)\b[^\n]*(-Recurse|\/s|-r)\b/i,
    platforms: ['win32']
  },
  {
    severity: 'critical',
    reason: 'Disk formatting or partitioning',
    pattern: /\b(mkfs|fdisk|parted|diskpart|Format-Volume)\b/i,
    platforms: ['linux', 'darwin', 'win32']
  },
  {
    severity: 'critical',
    reason: 'Direct write to block device',
    pattern: /\bdd\s+if=.*of=\/dev\//i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'critical',
    reason: 'Fork bomb',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?/,
    platforms: ['linux', 'darwin']
  },

  // High - privileged or dangerous
  {
    severity: 'high',
    reason: 'Privilege escalation',
    pattern: /\b(sudo|su\s+-?|doas)\b/i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'high',
    reason: 'Privilege escalation (Windows)',
    pattern: /\b(runas|gsudo|Start-Process\s+.*-Verb\s+RunAs)\b/i,
    platforms: ['win32']
  },
  {
    severity: 'high',
    reason: 'Remote script execution',
    pattern: /\b(curl|wget|fetch)\b[^\n]*\|\s*(ba)?sh/i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'high',
    reason: 'Remote script execution (PowerShell)',
    pattern: /\b(Invoke-Expression|iex)\b[^\n]*\b(Invoke-WebRequest|iwr|curl)\b/i,
    platforms: ['win32']
  },
  {
    severity: 'high',
    reason: 'Execution policy bypass',
    pattern: /\bSet-ExecutionPolicy\s+(Bypass|Unrestricted)\b/i,
    platforms: ['win32']
  },
  {
    severity: 'high',
    reason: 'Force kill processes',
    pattern: /\b(kill\s+-9\s+-1|killall\s+-9|pkill\s+-9|taskkill\s+.*\/F|Stop-Process\s+.*-Force)\b/i,
    platforms: ['linux', 'darwin', 'win32']
  },
  {
    severity: 'high',
    reason: 'Dangerous permission change',
    pattern: /\bchmod\s+(-R\s+)?(777|666|a\+rwx)\b/i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'high',
    reason: 'Recursive ownership change',
    pattern: /\bchown\s+-R\b/i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'high',
    reason: 'Registry modification',
    pattern: /\b(reg\s+delete|regedit|Remove-ItemProperty\s+.*Registry)\b/i,
    platforms: ['win32']
  },

  // Medium - risky operations
  {
    severity: 'medium',
    reason: 'Destructive git operation',
    pattern: /\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-[fd])\b/i,
    platforms: ['linux', 'darwin', 'win32']
  },
  {
    severity: 'medium',
    reason: 'Package removal',
    pattern: /\b(apt|yum|dnf|pacman)\s+(remove|purge|autoremove)\b/i,
    platforms: ['linux']
  },
  {
    severity: 'medium',
    reason: 'Package removal (Homebrew)',
    pattern: /\bbrew\s+uninstall\b/i,
    platforms: ['darwin']
  },
  {
    severity: 'medium',
    reason: 'Service stop/disable',
    pattern: /\b(systemctl|service)\s+(stop|disable|mask)\b/i,
    platforms: ['linux', 'darwin']
  },
  {
    severity: 'medium',
    reason: 'Service stop (Windows)',
    pattern: /\b(Stop-Service|sc\s+stop)\b/i,
    platforms: ['win32']
  },
  {
    severity: 'medium',
    reason: 'Firewall modification',
    pattern: /\b(iptables|ufw|firewall-cmd|netsh)\b[^\n]*(delete|remove|drop|reject|firewall)\b/i,
    platforms: ['linux', 'darwin', 'win32']
  }
];

const severityOrder: CommandSeverity[] = ['critical', 'high', 'medium', 'none'];

export function analyzeDangerousCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): { severity: CommandSeverity; reason?: string; match?: CommandSafetyMatch } {
  const platformKey: CommandPlatform = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';

  const matches = patterns.filter(match =>
    (match.platforms.includes('all') || match.platforms.includes(platformKey)) && match.pattern.test(command)
  );

  if (matches.length === 0) {
    return { severity: 'none' };
  }

  const sorted = matches.sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
  );

  const top = sorted[0];
  return { severity: top.severity, reason: top.reason, match: top };
}
