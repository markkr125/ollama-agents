import { minimatch } from 'minimatch';

export type FileSensitivitySeverity = 'critical' | 'high' | 'medium';

/**
 * Self-documenting action for file sensitivity patterns.
 * - `'auto-approve'` — file edits matching this pattern are approved automatically
 * - `'require-approval'` — file edits matching this pattern need user confirmation
 *
 * Legacy boolean values are supported for backward compatibility with existing
 * database records and VS Code settings:
 * - `true`  → treated as `'auto-approve'`
 * - `false` → treated as `'require-approval'`
 */
export type FilePatternAction = 'auto-approve' | 'require-approval';

/** Patterns can use either the new string actions or legacy booleans. */
export type FilePatternMap = Record<string, FilePatternAction | boolean>;

export type FileSensitivityDecision = {
  requiresApproval: boolean;
  severity: FileSensitivitySeverity;
  reason?: string;
  matchedPattern?: string;
};

export const DEFAULT_SENSITIVE_FILE_PATTERNS: FilePatternMap = {
  '**/*': 'auto-approve',
  '**/.env*': 'require-approval',
  '**/.vscode/*.json': 'require-approval',
  '**/package.json': 'require-approval',
  '**/package-lock.json': 'require-approval',
  '**/yarn.lock': 'require-approval',
  '**/pnpm-lock.yaml': 'require-approval',
  '**/*.pem': 'require-approval',
  '**/*.key': 'require-approval',
  '**/*.pfx': 'require-approval',
  '**/*.p12': 'require-approval',
  '**/tsconfig.json': 'require-approval',
  '**/jsconfig.json': 'require-approval',
  '**/Dockerfile': 'require-approval',
  '**/docker-compose*.yml': 'require-approval',
  '**/docker-compose*.yaml': 'require-approval',
  '**/.github/workflows/*': 'require-approval',
  '**/.npmrc': 'require-approval',
  '**/.yarnrc': 'require-approval',
  '**/.yarnrc.yml': 'require-approval',
  '**/*.secrets.*': 'require-approval'
};

const CRITICAL_PATH_PATTERNS: RegExp[] = [
  /(^|\/|\\)\.env(\.|$)/i,
  /secrets?/i,
  /\.(pem|key|pfx|p12)$/i,
  /(^|\/|\\)id_(rsa|ed25519)$/i
];

const HIGH_PATH_PATTERNS: RegExp[] = [
  /(^|\/|\\)package\.json$/i,
  /(^|\/|\\)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  /(^|\/|\\)(tsconfig|jsconfig)\.json$/i,
  /(^|\/|\\)dockerfile$/i,
  /docker-compose.*\.ya?ml$/i,
  /(^|\/|\\)\.github(\/|\\)workflows(\/|\\)/i,
  /(^|\/|\\)\.npmrc$/i,
  /(^|\/|\\)\.yarnrc(\.yml)?$/i,
  /(^|\/|\\)\.vscode(\/|\\).*\.json$/i
];

const MEDIUM_PATH_PATTERNS: RegExp[] = [
  /(^|\/|\\)\.eslintrc(\.|$)/i,
  /(^|\/|\\)\.prettierrc(\.|$)/i,
  /(^|\/|\\)\.editorconfig$/i,
  /(^|\/|\\)\.babelrc(\.|$)/i,
  /\.(config|rc)\.(js|ts|json)$/i
];

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const matchesAny = (filePath: string, patterns: RegExp[]): boolean =>
  patterns.some(pattern => pattern.test(filePath));

export const getFileSeverity = (filePath: string): FileSensitivitySeverity => {
  const normalized = normalizePath(filePath);
  if (matchesAny(normalized, CRITICAL_PATH_PATTERNS)) {
    return 'critical';
  }
  if (matchesAny(normalized, HIGH_PATH_PATTERNS)) {
    return 'high';
  }
  return matchesAny(normalized, MEDIUM_PATH_PATTERNS) ? 'medium' : 'medium';
};

/**
 * Evaluate whether a file path requires approval based on glob patterns.
 * Iterates patterns in insertion order — the **last matching pattern wins**.
 *
 * Accepts both new `FilePatternAction` strings and legacy `boolean` values
 * for backward compatibility with existing DB records and VS Code settings.
 */
export const evaluateFileSensitivity = (
  filePath: string,
  patterns: FilePatternMap
): FileSensitivityDecision => {
  const normalized = normalizePath(filePath);
  let matchedPattern: string | undefined;
  let matchedValue: FilePatternAction | boolean | undefined;

  for (const [pattern, value] of Object.entries(patterns || {})) {
    if (minimatch(normalized, pattern, { dot: true, nocase: true })) {
      matchedPattern = pattern;
      matchedValue = value;
    }
  }

  // Normalize: false / 'require-approval' → requires approval
  //            true  / 'auto-approve'     → auto-approved
  const requiresApproval = matchedValue === false || matchedValue === 'require-approval';
  const severity = getFileSeverity(normalized);
  const reason = requiresApproval && matchedPattern
    ? `Matched sensitive pattern: ${matchedPattern}`
    : undefined;

  return {
    requiresApproval,
    severity,
    reason,
    matchedPattern
  };
};
