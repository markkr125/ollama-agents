import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Project context discovery — automatically reads well-known project files
// at session start and injects relevant context into the system prompt.
// Inspired by Claude Code's automatic CLAUDE.md loading.
// ---------------------------------------------------------------------------

/** Well-known project files that provide useful context, ordered by priority. */
const PROJECT_CONTEXT_FILES = [
  // AI-specific instructions
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  'AGENTS.md',
  '.ai-instructions.md',

  // Project metadata
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'CMakeLists.txt',
  'Makefile',

  // Config files
  'tsconfig.json',
  '.eslintrc.json',
  '.eslintrc.js',
  'eslint.config.mjs',
  '.prettierrc',
  'vite.config.ts',
  'webpack.config.js',
  'next.config.js',
  'nuxt.config.ts',

  // Documentation
  'README.md',
  'CONTRIBUTING.md',
];

/** Maximum bytes to read from any single file. */
const MAX_FILE_BYTES = 4000;

/** Maximum total bytes for all project context combined. */
const MAX_TOTAL_BYTES = 12000;

export interface ProjectContextResult {
  /** The formatted context string ready for prompt injection. */
  contextBlock: string;
  /** Which files were successfully read. */
  filesRead: string[];
  /** Detected project type (e.g., "TypeScript/Node.js", "Python", "Rust"). */
  projectType: string;
}

/**
 * Discover project context from the workspace root.
 * Reads well-known files and returns a formatted context block.
 */
export async function discoverProjectContext(
  workspaceFolder?: vscode.WorkspaceFolder
): Promise<ProjectContextResult> {
  if (!workspaceFolder) {
    return { contextBlock: '', filesRead: [], projectType: 'unknown' };
  }

  const rootPath = workspaceFolder.uri.fsPath;
  const sections: string[] = [];
  const filesRead: string[] = [];
  let totalBytes = 0;
  let projectType = 'unknown';

  for (const relPath of PROJECT_CONTEXT_FILES) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;

    const fullPath = path.join(rootPath, relPath);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;

      const content = await fs.readFile(fullPath, 'utf-8');
      const truncated = content.substring(0, MAX_FILE_BYTES);
      const wasTruncated = content.length > MAX_FILE_BYTES;

      // Detect project type from key files
      if (relPath === 'package.json') {
        projectType = detectProjectTypeFromPackageJson(truncated);
      } else if (relPath === 'pyproject.toml' && projectType === 'unknown') {
        projectType = 'Python';
      } else if (relPath === 'Cargo.toml' && projectType === 'unknown') {
        projectType = 'Rust';
      } else if (relPath === 'go.mod' && projectType === 'unknown') {
        projectType = 'Go';
      } else if (relPath === 'pom.xml' && projectType === 'unknown') {
        projectType = 'Java';
      } else if (relPath === 'Gemfile' && projectType === 'unknown') {
        projectType = 'Ruby';
      } else if (relPath === 'composer.json' && projectType === 'unknown') {
        projectType = 'PHP';
      }

      sections.push(`### ${relPath}\n\`\`\`\n${truncated}${wasTruncated ? '\n... (truncated)' : ''}\n\`\`\``);
      filesRead.push(relPath);
      totalBytes += truncated.length;
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  if (sections.length === 0) {
    return { contextBlock: '', filesRead: [], projectType };
  }

  const contextBlock = `<project_context>\n## Project Context (auto-discovered)\nProject type: ${projectType}\n\n${sections.join('\n\n')}\n</project_context>`;

  return { contextBlock, filesRead, projectType };
}

/**
 * Extract project type from package.json content.
 */
function detectProjectTypeFromPackageJson(content: string): string {
  try {
    const pkg = JSON.parse(content);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps['@types/vscode'] || deps['vscode']) return 'VS Code Extension (TypeScript)';
    if (deps['next']) return 'Next.js (TypeScript/JavaScript)';
    if (deps['nuxt'] || deps['nuxt3']) return 'Nuxt.js (Vue)';
    if (deps['vue']) return 'Vue.js';
    if (deps['react']) return 'React';
    if (deps['svelte'] || deps['@sveltejs/kit']) return 'Svelte';
    if (deps['express'] || deps['fastify'] || deps['koa']) return 'Node.js Server';
    if (deps['electron']) return 'Electron';
    if (deps['typescript']) return 'TypeScript/Node.js';
    return 'Node.js';
  } catch {
    return 'Node.js';
  }
}
