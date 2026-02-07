---
name: copilot-custom-instructions
description: "How to write and organize VS Code Copilot custom instructions (.instructions.md) and agent skills (SKILL.md). Use when creating, editing, reorganizing, or debugging custom instruction or skill files, or when asked about applyTo glob syntax."
---

# Writing Custom Instructions & Agent Skills\n\n> **⚠️ Structural rules**: Do NOT rename, move, or delete instruction/skill files without updating the preamble table in `copilot-instructions.md`. Run `npm run lint:docs` to verify all cross-references. See pitfall #11.

This skill documents the file formats and conventions for VS Code Copilot custom instructions and agent skills, so you don't need to look up external documentation.

## `.instructions.md` Files (Scoped Instructions)

### File Format

```yaml
---
name: "Display Name"              # optional, defaults to filename
description: "Short description"  # optional
applyTo: "**/*.py"               # optional glob; if omitted, manual-attach only
---

# Markdown body with instructions
```

### `applyTo` Glob Syntax

- Single pattern: `"src/services/**"`
- Multiple patterns (comma-separated in a single string): `"**/*.ts,**/*.tsx"`
- Match all files: `"**"`
- If omitted, the instructions file is not applied automatically (user must attach it manually)
- Paths are relative to the workspace root

**Supported glob patterns:**

| Pattern | Meaning |
|---------|---------|
| `*` | All files in the current directory |
| `**` or `**/*` | All files in all directories |
| `*.py` | All `.py` files in the current directory |
| `**/*.py` | Recursively match all `.py` files |
| `src/**/*.py` | Recursively match `.py` files in `src/` |

### Storage Location

- **Workspace-level**: `.github/instructions/<name>.instructions.md`
- **User-level**: VS Code profile folder (syncable via Settings Sync)
- **Additional folders**: Configurable via `chat.instructionsFilesLocations` setting

### Relevant Settings

| Setting | Purpose |
|---------|---------|
| `github.copilot.chat.codeGeneration.useInstructionFiles` | Enable `.instructions.md` files |
| `chat.includeApplyingInstructions` | Auto-apply instructions with matching `applyTo` |

### When to Use

- General coding standards and conventions
- Language or framework-specific rules
- File-pattern-specific guidelines (e.g., all test files, all Vue components)
- Always-on or glob-matched context

---

## `SKILL.md` Files (Agent Skills)

### File Format

```yaml
---
name: my-skill-name              # required, lowercase with hyphens
description: "What this skill does and WHEN Copilot should use it"  # required
license: "MIT"                   # optional
---

# Markdown body with detailed instructions, steps, examples
```

### Key Differences from Instructions

| Aspect | Custom Instructions | Agent Skills |
|--------|-------------------|-------------|
| **Scope** | Always-on or glob-matched | Loaded on-demand when relevant |
| **Complexity** | Simple markdown guidelines | Folders with SKILL.md + optional scripts/resources |
| **Use case** | General coding standards | Specialized, repeatable tasks |
| **Selection** | Automatic by `applyTo` glob | Copilot decides based on `description` field |

### Storage Locations

- **Project skills**: `.github/skills/<skill-name>/SKILL.md`
- **Personal skills**: `~/.copilot/skills/<skill-name>/SKILL.md`

The file **must** be named `SKILL.md` exactly. Each skill lives in its own directory whose name should be lowercase with hyphens and typically match the `name` frontmatter field.

### How Copilot Uses Skills

1. Copilot reads the `description` field of each available skill
2. Based on the user's prompt, it decides which skills are relevant
3. When chosen, the full `SKILL.md` content is injected into the agent's context
4. The agent follows those instructions using any scripts/examples in the skill's directory

### Relevant Settings

| Setting | Purpose |
|---------|---------|
| `chat.useAgentSkills` | Enable agent skills loading |

### When to Use

- Step-by-step recipes for specific tasks (e.g., "add a new API endpoint")
- Specialized debugging workflows
- Complex multi-file scaffolding patterns
- Any task where detailed, on-demand instructions are more appropriate than always-loaded context

---

## Root `copilot-instructions.md`

The file at `.github/copilot-instructions.md` is always loaded for all chat requests in the workspace. Use it for:
- Project overview and architecture
- Critical invariants that apply everywhere
- Build/run commands and common issues

Keep it focused — move file-specific details to scoped `.instructions.md` files.

Requires `github.copilot.chat.codeGeneration.useInstructionFiles` to be enabled.

---

## Debugging

- **VS Code**: Right-click the Chat view → "Diagnostics" to see all loaded instruction files
- **`applyTo` not matching?**: Check that the glob pattern matches the file you're working on (relative to workspace root)
- **Skill not loading?**: Check that the `description` field clearly describes when it should be used
