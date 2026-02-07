#!/usr/bin/env node
/**
 * Structural linter for documentation, instructions, and skills.
 *
 * Validates:
 * 1. Every .instructions.md has valid YAML frontmatter (applyTo, description)
 * 2. Every skill folder has a SKILL.md with frontmatter (name, description)
 * 3. Every docs/*.md (except README.md) has a "## Table of Contents" heading
 * 4. The preamble table in copilot-instructions.md lists all instruction files
 * 5. The preamble skills table lists all skill folders
 * 6. No orphaned instruction/skill files (exist on disk but missing from preamble)
 * 7. docs/README.md index table lists all docs/*.md files (except itself)
 *
 * Exit code 0 = pass, 1 = failures found.
 *
 * Usage: node scripts/lint-docs.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INSTRUCTIONS_DIR = path.join(ROOT, '.github', 'instructions');
const SKILLS_DIR = path.join(ROOT, '.github', 'skills');
const DOCS_DIR = path.join(ROOT, 'docs');
const COPILOT_INSTRUCTIONS = path.join(ROOT, '.github', 'copilot-instructions.md');
const DOCS_README = path.join(ROOT, 'docs', 'README.md');

const errors = [];

function error(msg) {
  errors.push(msg);
  console.error(`  ✗ ${msg}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract YAML frontmatter fields from a markdown file. */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+)\s*:\s*(.+)/);
    if (m) {
      fields[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return fields;
}

/** List files in a directory matching a filter. */
function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(filter);
}

/** List subdirectories. */
function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f =>
    fs.statSync(path.join(dir, f)).isDirectory()
  );
}

// ---------------------------------------------------------------------------
// 1. Validate instruction files
// ---------------------------------------------------------------------------

console.log('\n📄 Instruction files (.github/instructions/)');
const instructionFiles = listFiles(INSTRUCTIONS_DIR, f => f.endsWith('.instructions.md'));

if (instructionFiles.length === 0) {
  error('No instruction files found');
} else {
  for (const file of instructionFiles) {
    const content = fs.readFileSync(path.join(INSTRUCTIONS_DIR, file), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) {
      error(`${file}: missing YAML frontmatter (--- block)`);
    } else {
      if (!fm.applyTo) error(`${file}: frontmatter missing "applyTo" field`);
      if (!fm.description) error(`${file}: frontmatter missing "description" field`);
      if (fm.applyTo && fm.description) ok(`${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Validate skill folders
// ---------------------------------------------------------------------------

console.log('\n🛠️  Skills (.github/skills/)');
const skillFolders = listDirs(SKILLS_DIR);

if (skillFolders.length === 0) {
  error('No skill folders found');
} else {
  for (const folder of skillFolders) {
    const skillMd = path.join(SKILLS_DIR, folder, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      error(`${folder}/: missing SKILL.md`);
      continue;
    }
    const content = fs.readFileSync(skillMd, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) {
      error(`${folder}/SKILL.md: missing YAML frontmatter`);
    } else {
      if (!fm.name) error(`${folder}/SKILL.md: frontmatter missing "name" field`);
      if (!fm.description) error(`${folder}/SKILL.md: frontmatter missing "description" field`);
      if (fm.name && fm.description) ok(`${folder}/`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Validate docs have Table of Contents
// ---------------------------------------------------------------------------

console.log('\n📚 Documentation files (docs/)');
const docFiles = listFiles(DOCS_DIR, f => f.endsWith('.md') && f !== 'README.md');

for (const file of docFiles) {
  const content = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
  if (!/^## Table of Contents/m.test(content)) {
    error(`${file}: missing "## Table of Contents" heading`);
  } else {
    ok(`${file}: has TOC`);
  }
}

// ---------------------------------------------------------------------------
// 4 & 5. Validate preamble table in copilot-instructions.md
// ---------------------------------------------------------------------------

console.log('\n📋 Preamble table (copilot-instructions.md)');
const preambleContent = fs.readFileSync(COPILOT_INSTRUCTIONS, 'utf8');

// Extract instruction file references from the preamble table
const preambleInstructionRefs = [];
const instructionTableRegex = /\| `\.github\/instructions\/([^`]+)` \|/g;
let m;
while ((m = instructionTableRegex.exec(preambleContent)) !== null) {
  preambleInstructionRefs.push(m[1]);
}

// Check every instruction file on disk is listed in the preamble
for (const file of instructionFiles) {
  if (preambleInstructionRefs.includes(file)) {
    ok(`Instruction listed: ${file}`);
  } else {
    error(`Instruction file "${file}" exists on disk but is NOT listed in copilot-instructions.md preamble`);
  }
}

// Check every preamble entry actually exists on disk
for (const ref of preambleInstructionRefs) {
  if (!instructionFiles.includes(ref)) {
    error(`Preamble references "${ref}" but the file does not exist in .github/instructions/`);
  }
}

// Extract skill folder references from the preamble table
const preambleSkillRefs = [];
const skillTableRegex = /\| `\.github\/skills\/([^/]+)\//g;
while ((m = skillTableRegex.exec(preambleContent)) !== null) {
  preambleSkillRefs.push(m[1]);
}

// Check every skill folder on disk is listed in the preamble
for (const folder of skillFolders) {
  if (preambleSkillRefs.includes(folder)) {
    ok(`Skill listed: ${folder}/`);
  } else {
    error(`Skill folder "${folder}/" exists on disk but is NOT listed in copilot-instructions.md preamble`);
  }
}

// Check every preamble skill entry actually exists on disk
for (const ref of preambleSkillRefs) {
  if (!skillFolders.includes(ref)) {
    error(`Preamble references skill "${ref}/" but the folder does not exist in .github/skills/`);
  }
}

// ---------------------------------------------------------------------------
// 6. Validate docs/README.md index lists all doc files
// ---------------------------------------------------------------------------

console.log('\n📖 Docs index (docs/README.md)');
if (fs.existsSync(DOCS_README)) {
  const indexContent = fs.readFileSync(DOCS_README, 'utf8');

  for (const file of docFiles) {
    // Check if the filename appears as a markdown link target
    if (indexContent.includes(`(${file})`)) {
      ok(`Docs index links to: ${file}`);
    } else {
      error(`"${file}" exists in docs/ but is NOT linked in docs/README.md`);
    }
  }
} else {
  error('docs/README.md does not exist');
}

// ---------------------------------------------------------------------------
// 7. Validate no 'vscode' imports in webview source
// ---------------------------------------------------------------------------

console.log('\n🚫 Import boundary (src/webview/ must not import vscode)');
const WEBVIEW_DIR = path.join(ROOT, 'src', 'webview');

function findTsFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findTsFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) {
      results.push(full);
    }
  }
  return results;
}

if (fs.existsSync(WEBVIEW_DIR)) {
  const webviewFiles = findTsFiles(WEBVIEW_DIR);
  let violations = 0;
  for (const file of webviewFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: import ... from 'vscode'  or  import * as vscode  or  require('vscode')
      // But skip type-only imports (import type { ... } from 'vscode') — those are OK
      if (
        (/from\s+['"]vscode['"]/.test(line) || /require\s*\(\s*['"]vscode['"]/.test(line)) &&
        !/^\s*import\s+type\s/.test(line)
      ) {
        const rel = path.relative(ROOT, file);
        error(`${rel}:${i + 1}: imports 'vscode' module (forbidden in webview sandbox)`);
        violations++;
      }
    }
  }
  if (violations === 0) ok('No vscode imports found in webview code');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (errors.length === 0) {
  console.log('✅ All documentation structure checks passed.\n');
  process.exit(0);
} else {
  console.error(`❌ ${errors.length} error(s) found.\n`);
  process.exit(1);
}
