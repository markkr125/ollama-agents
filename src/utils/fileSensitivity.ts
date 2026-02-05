import { minimatch } from 'minimatch';

export type FileSensitivitySeverity = 'critical' | 'high' | 'medium';

export type FileSensitivityDecision = {
  requiresApproval: boolean;
  severity: FileSensitivitySeverity;
  reason?: string;
  matchedPattern?: string;
};

export const DEFAULT_SENSITIVE_FILE_PATTERNS: Record<string, boolean> = {
  '**/*': true,
  '**/.env*': false,
  '**/.vscode/*.json': false,
  '**/package.json': false,
  '**/package-lock.json': false,
  '**/yarn.lock': false,
  '**/pnpm-lock.yaml': false,
  '**/*.pem': false,
  '**/*.key': false,
  '**/*.pfx': false,
  '**/*.p12': false,
  '**/tsconfig.json': false,
  '**/jsconfig.json': false,
  '**/Dockerfile': false,
  '**/docker-compose*.yml': false,
  '**/docker-compose*.yaml': false,
  '**/.github/workflows/*': false,
  '**/.npmrc': false,
  '**/.yarnrc': false,
  '**/.yarnrc.yml': false,
  '**/*.secrets.*': false
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

export const evaluateFileSensitivity = (
  filePath: string,
  patterns: Record<string, boolean>
): FileSensitivityDecision => {
  const normalized = normalizePath(filePath);
  let matchedPattern: string | undefined;
  let matchedValue: boolean | undefined;

  for (const [pattern, value] of Object.entries(patterns || {})) {
    if (minimatch(normalized, pattern, { dot: true, nocase: true })) {
      matchedPattern = pattern;
      matchedValue = value;
    }
  }

  const requiresApproval = matchedValue === false;
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
