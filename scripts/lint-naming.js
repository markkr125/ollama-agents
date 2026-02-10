#!/usr/bin/env node
/**
 * Naming convention linter for files and folders.
 *
 * Enforced conventions:
 *
 * FOLDERS
 *   All source/test folders must be camelCase or lowercase single-word.
 *   Examples: agent, messageHandlers, core, agent/tools
 *
 * FILES
 *   .ts files  → camelCase        (agentChatExecutor.ts, timelineBuilder.ts)
 *   .vue files → PascalCase       (ChatPage.vue, HeaderBar.vue)
 *   .test.ts   → mirrors source   (timelineBuilder.test.ts, CommandApproval.test.ts)
 *   .d.ts      → camelCase/lower  (ollama.ts, diff2html.d.ts)
 *   .scss      → _kebab-case      (_command-approval.scss) or camelCase (styles.scss)
 *   Special    → index.ts, main.ts, setup.ts, vite.config.ts (allowed as-is)
 *
 * Scanned directories: src/, tests/
 * Ignored: node_modules, .vite, out, dist, media
 *
 * Usage: node scripts/lint-naming.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const errors = [];

function error(msg) {
  errors.push(msg);
  console.error(`  ✗ ${msg}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// camelCase: starts with lowercase letter, rest is alphanumeric (allows consecutive uppercase for abbreviations)
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

// PascalCase: starts with uppercase letter, rest is alphanumeric
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;

// Folder name: camelCase or all-lowercase single word
const VALID_FOLDER = /^[a-z][a-zA-Z0-9]*$/;

// SCSS partial: starts with _ then kebab-case
const SCSS_PARTIAL = /^_[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Special files that are exempt from naming rules
const SPECIAL_FILES = new Set([
  'index.ts', 'main.ts', 'setup.ts',
  'App.ts', // Webview entry — mirrors App.vue
  'index.html', 'styles.scss',
  'vite.config.ts', 'vitest.config.ts',
]);

// Directories to ignore entirely
const IGNORED_DIRS = new Set([
  'node_modules', '.vite', 'out', 'dist', 'media',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the "stem" of a filename (without extensions). Handles .test.ts, .d.ts, etc. */
function getStem(filename) {
  // .test.ts → remove .test.ts
  if (filename.endsWith('.test.ts')) return filename.slice(0, -8);
  // .d.ts → remove .d.ts
  if (filename.endsWith('.d.ts')) return filename.slice(0, -5);
  // .config.ts → remove .config.ts
  if (filename.endsWith('.config.ts')) return filename.slice(0, -10);
  // Normal: remove last extension
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Get the full extension including compound ones like .test.ts */
function getExt(filename) {
  if (filename.endsWith('.test.ts')) return '.test.ts';
  if (filename.endsWith('.d.ts')) return '.d.ts';
  if (filename.endsWith('.config.ts')) return '.config.ts';
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot) : '';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateFolder(relPath, name) {
  if (!VALID_FOLDER.test(name)) {
    error(`Folder "${relPath}" — name "${name}" must be camelCase (e.g., messageHandlers, core)`);
    return false;
  }
  return true;
}

function validateFile(relPath, filename) {
  if (SPECIAL_FILES.has(filename)) return true;

  const stem = getStem(filename);
  const ext = getExt(filename);

  switch (ext) {
    case '.vue':
      if (!PASCAL_CASE.test(stem)) {
        error(`File "${relPath}" — Vue components must be PascalCase (e.g., ChatPage.vue)`);
        return false;
      }
      break;

    case '.ts':
      if (!CAMEL_CASE.test(stem)) {
        error(`File "${relPath}" — TypeScript files must be camelCase (e.g., agentChatExecutor.ts)`);
        return false;
      }
      break;

    case '.test.ts':
      // Test files mirror their source: camelCase for .ts sources, PascalCase for .vue sources
      if (!CAMEL_CASE.test(stem) && !PASCAL_CASE.test(stem)) {
        error(`File "${relPath}" — Test files must be camelCase or PascalCase (mirroring source)`);
        return false;
      }
      break;

    case '.d.ts':
      // Declaration files: camelCase or lowercase
      if (!CAMEL_CASE.test(stem) && !/^[a-z][a-z0-9]*$/.test(stem)) {
        error(`File "${relPath}" — Declaration files must be camelCase or lowercase`);
        return false;
      }
      break;

    case '.scss': {
      // SCSS partials start with _, rest is kebab-case
      const scssStem = filename.replace(/\.scss$/, '');
      if (scssStem.startsWith('_')) {
        if (!SCSS_PARTIAL.test(scssStem)) {
          error(`File "${relPath}" — SCSS partials must be _kebab-case (e.g., _command-approval.scss)`);
          return false;
        }
      } else if (!CAMEL_CASE.test(scssStem) && !/^[a-z][a-z0-9]*$/.test(scssStem)) {
        error(`File "${relPath}" — SCSS files must be camelCase or lowercase`);
        return false;
      }
      break;
    }

    case '.html':
      // HTML files: camelCase or lowercase
      if (!CAMEL_CASE.test(stem) && !/^[a-z][a-z0-9]*$/.test(stem)) {
        error(`File "${relPath}" — HTML files must be camelCase or lowercase`);
        return false;
      }
      break;

    default:
      // Unknown extension — skip
      break;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Walk directories
// ---------------------------------------------------------------------------

function walk(dir, relBase) {
  let folderCount = 0;
  let fileCount = 0;
  let folderErrors = 0;
  let fileErrors = 0;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.join(relBase, entry.name);

    if (entry.isDirectory()) {
      folderCount++;
      if (!validateFolder(relPath, entry.name)) folderErrors++;
      const sub = walk(fullPath, relPath);
      folderCount += sub.folderCount;
      fileCount += sub.fileCount;
      folderErrors += sub.folderErrors;
      fileErrors += sub.fileErrors;
    } else if (entry.isFile()) {
      const ext = getExt(entry.name);
      // Only lint source-related extensions
      if (['.ts', '.test.ts', '.d.ts', '.config.ts', '.vue', '.scss', '.html'].includes(ext) || SPECIAL_FILES.has(entry.name)) {
        fileCount++;
        if (!validateFile(relPath, entry.name)) fileErrors++;
      }
    }
  }

  return { folderCount, fileCount, folderErrors, fileErrors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('\n📁 Folder naming conventions');
const srcDir = path.join(ROOT, 'src');
const testsDir = path.join(ROOT, 'tests');

let totalFolders = 0;
let totalFiles = 0;
let totalFolderErrors = 0;
let totalFileErrors = 0;

for (const [label, dir] of [['src/', srcDir], ['tests/', testsDir]]) {
  if (!fs.existsSync(dir)) {
    error(`${label} directory not found`);
    continue;
  }
  // Validate the top-level directory entry itself
  const result = walk(dir, label);
  totalFolders += result.folderCount;
  totalFiles += result.fileCount;
  totalFolderErrors += result.folderErrors;
  totalFileErrors += result.fileErrors;
}

if (totalFolderErrors === 0) {
  ok(`All ${totalFolders} folders follow camelCase convention`);
}

console.log('\n📝 File naming conventions');
if (totalFileErrors === 0) {
  ok(`All ${totalFiles} files follow naming conventions (.ts=camelCase, .vue=PascalCase, .scss=_kebab-case)`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (errors.length === 0) {
  console.log('✅ All naming convention checks passed.\n');
  process.exit(0);
} else {
  console.error(`❌ ${errors.length} naming error(s) found.\n`);
  process.exit(1);
}
