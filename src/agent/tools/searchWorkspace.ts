import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Tool } from '../../types/agent';

/**
 * search_workspace — Search for text across workspace files using ripgrep
 * (bundled with VS Code) for fast, accurate results with line numbers and
 * context lines.
 *
 * Falls back to a manual line-by-line scan if ripgrep is unavailable.
 */

// ---------------------------------------------------------------------------
// Ripgrep binary discovery
// ---------------------------------------------------------------------------

function findRipgrepBinary(): string | undefined {
  // VS Code bundles ripgrep — try the known paths
  const appRoot = vscode.env.appRoot;
  const candidates = [
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
    path.join(appRoot, 'node_modules', 'vscode-ripgrep', 'bin', 'rg'),
    // Fallback: system-installed rg
    'rg'
  ];
  for (const candidate of candidates) {
    try {
      cp.execFileSync(candidate, ['--version'], { stdio: 'pipe', timeout: 3000 });
      return candidate;
    } catch {
      // Not found, try next
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ripgrep-based search
// ---------------------------------------------------------------------------

interface SearchMatch {
  file: string;
  line: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

async function searchWithRipgrep(
  rgPath: string,
  rootPaths: string[],
  query: string,
  opts: {
    filePattern?: string;
    isRegex?: boolean;
    maxResults: number;
    contextLines: number;
  }
): Promise<SearchMatch[]> {
  return new Promise((resolve) => {
    const args = [
      '--json',
      '--max-count', '5',          // max matches per file
      '--max-columns', '300',       // truncate long lines
      '--color', 'never',
      '--no-heading',
      '-C', String(opts.contextLines), // context lines
    ];

    if (!opts.isRegex) {
      args.push('--fixed-strings');
    }
    args.push('--smart-case');

    if (opts.filePattern) {
      args.push('--glob', opts.filePattern);
    }

    // Always exclude common noise
    args.push('--glob', '!node_modules/**');
    args.push('--glob', '!.git/**');
    args.push('--glob', '!dist/**');
    args.push('--glob', '!out/**');
    args.push('--glob', '!*.min.js');
    args.push('--glob', '!*.min.css');
    args.push('--glob', '!package-lock.json');
    // Exclude binary/diagnostic artifacts that produce massive, useless results
    args.push('--glob', '!*.heapsnapshot');
    args.push('--glob', '!*.log');
    args.push('--glob', '!*.cpuprofile');
    args.push('--glob', '!profiler/**');
    args.push('--glob', '!*.map');
    args.push('--glob', '!*.snap');
    args.push('--glob', '!*.wasm');
    args.push('--glob', '!*.pb');
    args.push('--glob', '!*.pyc');
    args.push('--glob', '!yarn.lock');
    args.push('--glob', '!pnpm-lock.yaml');

    // Pass query followed by all root paths (rg accepts multiple paths)
    args.push('--', query, ...rootPaths);

    const child = cp.spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });

    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', () => { /* ignore */ });

    child.on('close', () => {
      const matches: SearchMatch[] = [];
      const lines = stdout.split('\n').filter(Boolean);

      // Parse ripgrep JSON output
      let currentMatch: SearchMatch | null = null;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match') {
            if (matches.length >= opts.maxResults) break;
            // Use vscode.workspace.asRelativePath for multi-root friendly paths
            const absFile = obj.data.path.text;
            const relPath = vscode.workspace.asRelativePath(absFile, true);
            currentMatch = {
              file: relPath,
              line: obj.data.line_number,
              text: obj.data.lines.text.trimEnd(),
              contextBefore: [],
              contextAfter: []
            };
            matches.push(currentMatch);
          } else if (obj.type === 'context' && currentMatch) {
            const contextLine = obj.data.lines.text.trimEnd();
            if (obj.data.line_number < currentMatch.line) {
              currentMatch.contextBefore.push(contextLine);
            } else {
              currentMatch.contextAfter.push(contextLine);
            }
          }
        } catch {
          // Non-JSON line, skip
        }
      }
      resolve(matches);
    });

    child.on('error', () => resolve([]));
  });
}

// ---------------------------------------------------------------------------
// Fallback: manual search using vscode.workspace.fs
// ---------------------------------------------------------------------------

async function searchManual(
  _rootPaths: string[],
  query: string,
  opts: {
    filePattern?: string;
    maxResults: number;
    contextLines: number;
  }
): Promise<SearchMatch[]> {
  const glob = opts.filePattern || '**/*';
  const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/*.heapsnapshot,**/*.log,**/*.cpuprofile,**/profiler/**,**/*.map,**/*.snap}';
  // vscode.workspace.findFiles already searches all workspace folders
  const uris = await vscode.workspace.findFiles(glob, exclude, 500);
  const matches: SearchMatch[] = [];
  const lowerQuery = query.toLowerCase();

  for (const uri of uris) {
    if (matches.length >= opts.maxResults) break;
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(data);
      const lines = text.split('\n');
      // Use asRelativePath for multi-root friendly output
      const relPath = vscode.workspace.asRelativePath(uri, true);

      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= opts.maxResults) break;
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          const ctxStart = Math.max(0, i - opts.contextLines);
          const ctxEnd = Math.min(lines.length - 1, i + opts.contextLines);
          matches.push({
            file: relPath,
            line: i + 1,
            text: lines[i].trimEnd(),
            contextBefore: lines.slice(ctxStart, i).map(l => l.trimEnd()),
            contextAfter: lines.slice(i + 1, ctxEnd + 1).map(l => l.trimEnd())
          });
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Format matches for LLM consumption
// ---------------------------------------------------------------------------

function formatMatches(matches: SearchMatch[], query: string, rootPaths: string[]): string {
  if (matches.length === 0) {
    const searchedIn = rootPaths.map(p => vscode.workspace.asRelativePath(p, true)).join(', ');
    return `No matches for "${query}" in ${rootPaths.length} workspace folder${rootPaths.length !== 1 ? 's' : ''}: ${searchedIn}`;
  }

  // Group by file
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const existing = byFile.get(m.file) || [];
    existing.push(m);
    byFile.set(m.file, existing);
  }

  const parts: string[] = [];
  parts.push(`Found ${matches.length} match${matches.length !== 1 ? 'es' : ''} across ${byFile.size} file${byFile.size !== 1 ? 's' : ''}:\n`);

  for (const [file, fileMatches] of byFile) {
    parts.push(`── ${file} ──`);
    for (const m of fileMatches) {
      if (m.contextBefore.length > 0) {
        for (let i = 0; i < m.contextBefore.length; i++) {
          parts.push(`  ${m.line - m.contextBefore.length + i}: ${m.contextBefore[i]}`);
        }
      }
      parts.push(`→ ${m.line}: ${m.text}`);
      if (m.contextAfter.length > 0) {
        for (let i = 0; i < m.contextAfter.length; i++) {
          parts.push(`  ${m.line + 1 + i}: ${m.contextAfter[i]}`);
        }
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const searchWorkspaceTool: Tool = {
  name: 'search_workspace',
  description: 'Search for text or regex patterns across workspace files. Returns matching lines with file paths, line numbers, and surrounding context. IMPORTANT: To find multiple functions/symbols/classes, combine them ALL in ONE call with isRegex=true using | alternation (e.g. query="funcA|funcB|funcC" isRegex=true). Do NOT make separate calls for each symbol. Use plain text (isRegex=false) only for a single known exact string.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regex pattern to search for. To find MULTIPLE symbols at once, use regex alternation: "funcA|funcB|funcC" with isRegex=true. For regex: use (?i) for case-insensitive, | for alternatives, .* for wildcards.' },
      directory: { type: 'string', description: 'Optional: restrict search to a specific directory (relative to workspace root, or folder name in multi-root). When omitted, searches ALL workspace folders.' },
      filePattern: { type: 'string', description: 'Glob pattern to filter files (e.g. "**/*.ts", "src/**/*.py"). Optional.' },
      isRegex: { type: 'boolean', description: 'Set to true when searching for multiple symbols (a|b|c), case-insensitive, patterns, or when unsure of exact spelling. Default: false.' },
      maxResults: { type: 'number', description: 'Maximum number of matching lines to return. Default: 30' },
      contextLines: { type: 'number', description: 'Number of context lines before and after each match. Default: 2' }
    },
    required: ['query']
  },
  execute: async (params, context) => {
    const query = params.query || params.pattern || params.search;
    if (!query || typeof query !== 'string') {
      throw new Error('Missing required argument: query');
    }

    const maxResults = params.maxResults || 30;
    const contextLines = params.contextLines ?? 2;
    const filePattern = params.filePattern;
    const isRegex = params.isRegex ?? false;
    const directory = params.directory;

    // Collect all workspace root paths for multi-root support.
    // DEFENSIVE: always re-read vscode.workspace.workspaceFolders as well,
    // in case context.workspaceFolders was stale at construction time.
    const allFolders = context.workspaceFolders?.length
      ? context.workspaceFolders
      : vscode.workspace.workspaceFolders;
    let rootPaths = (allFolders && allFolders.length > 0)
      ? allFolders.map(f => f.uri.fsPath)
      : [context.workspace.uri.fsPath];

    // Optional directory scoping: if the model specifies a directory,
    // restrict search to paths under that directory.
    if (directory && typeof directory === 'string' && directory.trim()) {
      const dirTrimmed = directory.trim().replace(/\/+$/, '');
      // Check if it matches a workspace folder name (multi-root)
      if (allFolders && allFolders.length > 1) {
        const matchingFolder = Array.from(allFolders).find(
          f => f.name === dirTrimmed || f.name.toLowerCase() === dirTrimmed.toLowerCase()
        );
        if (matchingFolder) {
          rootPaths = [matchingFolder.uri.fsPath];
        } else {
          // Treat as a subdirectory relative to each root — filter to existing
          const path = require('path');
          const fs = require('fs');
          const scoped = rootPaths
            .map(r => path.join(r, dirTrimmed))
            .filter((p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
          if (scoped.length > 0) rootPaths = scoped;
        }
      } else {
        // Single-root: scope to subdirectory
        const path = require('path');
        const fs = require('fs');
        const scoped = path.join(rootPaths[0], dirTrimmed);
        try { if (fs.statSync(scoped).isDirectory()) rootPaths = [scoped]; } catch { /* keep original */ }
      }
    }

    const rgPath = findRipgrepBinary();
    let allMatches: SearchMatch[] = [];

    if (rgPath) {
      // Ripgrep natively accepts multiple search paths
      allMatches = await searchWithRipgrep(rgPath, rootPaths, query, { filePattern, isRegex, maxResults, contextLines });
    } else {
      // Manual fallback — vscode.workspace.findFiles already searches all roots
      allMatches = await searchManual(rootPaths, query, { filePattern, maxResults, contextLines });
    }

    return formatMatches(allMatches, query, rootPaths);
  }
};
