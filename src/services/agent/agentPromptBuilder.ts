import * as vscode from 'vscode';
import { ToolRegistry } from '../../agent/toolRegistry';
import { discoverProjectContext } from './projectContext';

// ---------------------------------------------------------------------------
// AgentPromptBuilder — modular system prompt assembly inspired by Claude Code's
// conditional prompt architecture. Each section is a named method that returns
// a prompt fragment. The builder assembles them based on model capabilities.
//
// Sections:
//   identity, workspaceInfo, toneAndStyle, doingTasks, toolUsagePolicy,
//   executingWithCare, codeNavigationStrategy, userProvidedContext,
//   searchTips, completionSignal, scratchpadDirectory,
//   toolDefinitions (XML fallback only), toolCallFormat (XML fallback only)
// ---------------------------------------------------------------------------

export class AgentPromptBuilder {
  private projectContextBlock = '';
  private detectedProjectType = 'unknown';

  constructor(
    private readonly toolRegistry: ToolRegistry
  ) {}

  /**
   * Discover and cache project context from the workspace.
   * Call this once before building prompts — it reads project files from disk.
   */
  async loadProjectContext(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
    const result = await discoverProjectContext(workspaceFolder);
    this.projectContextBlock = result.contextBlock;
    this.detectedProjectType = result.projectType;
  }

  /**
   * Build the full system prompt for native tool-calling models.
   * These models receive tool definitions via the Ollama `tools[]` parameter,
   * so the prompt focuses on behavioral rules and workspace context.
   */
  buildNativeToolPrompt(workspaceFolders: readonly vscode.WorkspaceFolder[], primaryWorkspace?: vscode.WorkspaceFolder): string {
    const sections = [
      this.identity(),
      this.workspaceInfo(workspaceFolders, primaryWorkspace),
      this.projectContextBlock,
      this.toneAndStyle(),
      this.doingTasks(),
      this.toolUsagePolicy(true),
      this.executingWithCare(),
      this.codeNavigationStrategy(),
      this.userProvidedContext(),
      this.searchTips(),
      this.scratchpadDirectory(),
      this.completionSignal(),
    ];
    return sections.filter(Boolean).join('\n\n');
  }

  /**
   * Build the full system prompt for XML fallback models.
   * These models don't support native tool calling, so the prompt includes
   * tool definitions, call format, and examples inline.
   */
  buildXmlFallbackPrompt(workspaceFolders: readonly vscode.WorkspaceFolder[], primaryWorkspace?: vscode.WorkspaceFolder): string {
    const sections = [
      this.identity(),
      this.workspaceInfo(workspaceFolders, primaryWorkspace),
      this.projectContextBlock,
      this.toneAndStyle(),
      this.doingTasks(),
      this.toolDefinitions(),
      this.toolCallFormat(),
      this.toolUsagePolicy(false),
      this.executingWithCare(),
      this.codeNavigationStrategy(),
      this.userProvidedContext(),
      this.searchTips(),
      this.scratchpadDirectory(),
      this.completionSignal(),
    ];
    return sections.filter(Boolean).join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Prompt sections
  // ---------------------------------------------------------------------------

  private identity(): string {
    return `You are an expert coding agent. Use the provided tools to complete tasks. You MUST use tools to make changes — never claim to do something without actually doing it.`;
  }

  private workspaceInfo(allFolders: readonly vscode.WorkspaceFolder[], primaryWorkspace?: vscode.WorkspaceFolder): string {
    if (allFolders.length > 1) {
      const folderList = allFolders.map(f => `  - ${f.name}: ${f.uri.fsPath}`).join('\n');
      return `WORKSPACE:
This is a multi-root workspace with ${allFolders.length} folders:
${folderList}
All file paths are relative to the folder that contains them (or prefixed with the folder name). The primary folder is: ${primaryWorkspace?.uri?.fsPath || allFolders[0]?.uri?.fsPath || ''}.
Terminal commands run in the primary workspace directory by default.`;
    }
    return `WORKSPACE:
The workspace root is: ${primaryWorkspace?.uri?.fsPath || allFolders[0]?.uri?.fsPath || '(unknown)'}. All file paths are relative to this workspace. Terminal commands run in this directory by default.`;
  }

  private toneAndStyle(): string {
    return `COMMUNICATION RULES:
- Be short and concise. Get to the point — don't pad responses with unnecessary explanation.
- Never create files unless absolutely necessary — always prefer editing existing files.
- Never proactively create documentation, README files, or config files unless the user explicitly asks.
- Prioritize technical accuracy over validating user beliefs — if the user is wrong, say so respectfully but clearly.
- Never give time estimates for how long tasks will take.
- Do not use terminal echo/cat to communicate with the user — respond with text directly.
- No emojis unless the user explicitly requests them.`;
  }

  private doingTasks(): string {
    return `TASK EXECUTION RULES:
- NEVER propose changes to code you haven't read — always read the relevant file first.
- Only make changes that are directly requested or clearly necessary to fulfill the request.
- Do NOT add features, refactor surrounding code, or "improve" things beyond what was asked.
- Do NOT add docstrings, comments, or type annotations to code you didn't change.
- Do NOT add error handling for scenarios that can't actually happen.
- Do NOT create helper functions, utility classes, or abstractions for one-time operations — three similar lines of code are better than a premature abstraction.
- Do NOT design for hypothetical future requirements — solve the problem at hand.
- If something is unused after your changes, delete it completely — don't leave dead code.
- Be careful not to introduce security vulnerabilities (injection, XSS, auth bypass, path traversal, etc.).
- When fixing a bug, fix the bug — don't refactor the surrounding code unless it's part of the fix.`;
  }

  private toolUsagePolicy(isNativeTools: boolean): string {
    const parallel = isNativeTools
      ? `- When multiple tool calls are independent of each other, make ALL of them in a single response. Do not call them one at a time sequentially.
- Only use sequential calls when one tool's result is needed as input for the next.`
      : `- When making multiple independent tool calls, emit all of them in your response. Don't use one tool, wait for the result, then use the next — batch them.`;

    return `TOOL USAGE RULES:
${parallel}
- Prefer specialized tools over terminal commands:
  • Use read_file instead of cat/head/tail
  • Use search_workspace instead of grep/rg
  • Use list_files instead of ls/find
  • Use get_diagnostics instead of running a compiler/linter CLI
- Do not use run_terminal_command with echo to communicate — respond with text directly.
- Start with broad exploration (list_files, search_workspace, get_document_symbols) to understand the codebase, then narrow down to specific files.`;
  }

  private executingWithCare(): string {
    return `SAFETY AND REVERSIBILITY:
- Freely take local, reversible actions: reading files, editing files, running tests, searching code.
- Be cautious with hard-to-reverse or destructive actions:
  • Deleting files or directories — verify they're truly unused first.
  • Force-pushing, git reset --hard, amending published commits — don't do these unless explicitly asked.
  • Dropping database tables, rm -rf — investigate before executing.
- Resolve merge conflicts by understanding both sides — don't discard one side blindly.
- Investigate lock files and permission errors instead of deleting/overridding them.
- Don't use destructive shortcuts to bypass obstacles — find the root cause.`;
  }

  private codeNavigationStrategy(): string {
    return `CODE NAVIGATION STRATEGY:
- Use get_document_symbols to get a file's outline (classes, functions, methods with line ranges) before reading the whole file.
- Use find_definition to follow a function/method call to its source — this works across files.
- Use find_references to find all usages of a symbol before modifying it.
- Use find_symbol to search for a class or function by name when you don't know which file it's in.
- Use get_hover_info to inspect the type or signature of a symbol without reading definition files.
- Use get_call_hierarchy to trace call chains — who calls a function, and what does it call.
- Use find_implementations to find concrete classes that implement an interface or abstract method.
- Use get_type_hierarchy to understand inheritance chains — what a class extends and what extends it.
- Use search_workspace for text/regex search with line numbers and context.
- Prefer get_document_symbols + targeted read_file over reading entire large files.`;
  }

  private userProvidedContext(): string {
    return `USER-PROVIDED CONTEXT:
The user may attach code from their editor to the message. This appears at the start of their message in blocks like:
  [file.ts:L10-L50] (selected lines 10–50)
  [file.ts] (whole file)
The code inside those blocks is ALREADY AVAILABLE to you — do NOT re-read it with read_file.
Use the provided content directly for analysis, explanation, or edits.
Only use read_file if you need lines OUTSIDE the provided range, or a different file entirely.`;
  }

  private searchTips(): string {
    return `SEARCH TIPS:
search_workspace supports regex via isRegex=true. Use regex when:
- You're unsure of exact casing/spelling
- You need case-insensitive search: (?i)pattern
- You want alternatives: word1|word2|word3
- Pattern matching: import.*something
Use plain text (default) for known exact strings.`;
  }

  private scratchpadDirectory(): string {
    return `TEMPORARY FILES:
If you need temporary files (test scripts, intermediate output, scratch work), create them in a .ollama-copilot-scratch/ directory at the workspace root. These are working files, not part of the user's project. Clean up scratch files when the task is complete.`;
  }

  private completionSignal(): string {
    return `COMPLETION:
When you have fully completed the task, respond with [TASK_COMPLETE] at the end of your final message. Do not use this signal until all requested changes have been made and verified.`;
  }

  // ---------------------------------------------------------------------------
  // XML fallback-only sections
  // ---------------------------------------------------------------------------

  private toolDefinitions(): string {
    const tools = this.toolRegistry.getAll();
    const descriptions = tools.map((t: { name: string; description: string; schema?: any }) => {
      const params = t.schema?.properties
        ? Object.entries(t.schema.properties)
            .map(([key, val]: [string, any]) => `    ${key}: ${val.description || val.type}`)
            .join('\n')
        : '    (no parameters)';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n');

    return `TOOLS:\n${descriptions}`;
  }

  private toolCallFormat(): string {
    return `FORMAT - Always use this exact format for tool calls:
<tool_call>{"name": "TOOL_NAME", "arguments": {"arg": "value"}}</tool_call>

EXAMPLES:
<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>
<tool_call>{"name": "write_file", "arguments": {"path": "file.txt", "content": "new content"}}</tool_call>
<tool_call>{"name": "find_definition", "arguments": {"path": "src/main.ts", "symbolName": "handleRequest"}}</tool_call>

CRITICAL: To edit a file you must call write_file. Reading alone does NOT change files.`;
  }

  // ---------------------------------------------------------------------------
  // Explore mode prompt — read-only, fast, parallel searches
  // ---------------------------------------------------------------------------

  buildExplorePrompt(workspaceFolders: readonly vscode.WorkspaceFolder[], primaryWorkspace?: vscode.WorkspaceFolder, useNativeTools?: boolean): string {
    const sections = [
      `You are a read-only code exploration agent. Your job is to find, read, and analyze code to answer the user's questions thoroughly and accurately.

STRICT CONSTRAINTS:
- You MUST NOT create, modify, or delete any files.
- You MUST NOT run commands that change system state.
- You are here to READ and ANALYZE only.`,
      this.workspaceInfo(workspaceFolders, primaryWorkspace),
      `EXPLORATION STRATEGY:
- Use list_files to discover project structure and find relevant directories.
- Use search_workspace to find specific code patterns, function names, or string literals.
- Use get_document_symbols to understand a file's structure before reading it entirely.
- Use find_definition to follow function calls to their implementations.
- Use find_references to find all places a symbol is used.
- Use find_implementations to find concrete implementations of interfaces.
- Use get_call_hierarchy to trace call chains.
- Use get_type_hierarchy for inheritance analysis.
- Use get_hover_info for quick type/signature checks.
- Use get_diagnostics to check for errors in files.
- Launch multiple parallel tool calls when searching broadly — don't search one thing at a time.
- Start broad, then narrow down to specific files and functions.
- Return file paths as workspace-relative paths.`,
      this.searchTips(),
      this.toneAndStyle(),
      `COMPLETION:
When you have thoroughly answered the question, respond with [TASK_COMPLETE].`,
    ];

    if (!useNativeTools) {
      sections.splice(2, 0, this.buildExploreToolDefinitions(), this.toolCallFormat());
    }

    return sections.filter(Boolean).join('\n\n');
  }

  /** Tool definitions for explore mode — only read-only tools. */
  private buildExploreToolDefinitions(): string {
    const readOnlyNames = new Set([
      'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
      'get_document_symbols', 'find_definition', 'find_references',
      'find_implementations', 'find_symbol', 'get_hover_info',
      'get_call_hierarchy', 'get_type_hierarchy',
    ]);
    const tools = this.toolRegistry.getAll().filter(t => readOnlyNames.has(t.name));
    const descriptions = tools.map((t: { name: string; description: string; schema?: any }) => {
      const params = t.schema?.properties
        ? Object.entries(t.schema.properties)
            .map(([key, val]: [string, any]) => `    ${key}: ${val.description || val.type}`)
            .join('\n')
        : '    (no parameters)';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n');
    return `TOOLS (read-only):\n${descriptions}`;
  }

  // ---------------------------------------------------------------------------
  // Plan mode prompt — read-only exploration + structured planning
  // ---------------------------------------------------------------------------

  buildPlanPrompt(workspaceFolders: readonly vscode.WorkspaceFolder[], primaryWorkspace?: vscode.WorkspaceFolder, useNativeTools?: boolean): string {
    const sections = [
      `You are an expert software architect and planning agent. Your job is to explore the codebase, understand the architecture, and create a detailed implementation plan for the user's request.

STRICT CONSTRAINTS:
- You MUST NOT create, modify, or delete any files.
- You MUST NOT run commands that change system state.
- You are here to EXPLORE, ANALYZE, and PLAN only.

PLANNING PROCESS:
1. UNDERSTAND REQUIREMENTS — Parse the user's request carefully. Identify both explicit and implicit needs.
2. EXPLORE CODEBASE — Use tools to find relevant files, patterns, and architecture. Understand existing conventions before proposing changes.
3. DESIGN SOLUTION — Based on exploration, design the implementation approach. Consider trade-offs, existing patterns, and potential pitfalls.
4. OUTPUT STRUCTURED PLAN — Provide a numbered step-by-step plan with:
   - Specific files to create or modify
   - What changes to make in each file
   - Dependencies between steps (what must happen before what)
   - Anticipated challenges or edge cases
5. End with "Critical Files for Implementation" listing the 3-5 most important files with brief reasons.`,
      this.workspaceInfo(workspaceFolders, primaryWorkspace),
      `EXPLORATION STRATEGY:
- Use list_files to discover project structure.
- Use search_workspace to find related code, patterns, and conventions.
- Use get_document_symbols to understand file structures.
- Use find_definition and find_references to trace code paths.
- Use get_call_hierarchy for understanding function relationships.
- Launch multiple parallel tool calls to explore efficiently.
- Read existing similar features to understand the project's conventions.`,
      this.searchTips(),
      this.toneAndStyle(),
      `COMPLETION:
When you have finished your plan, respond with [TASK_COMPLETE].
Your plan should be actionable — another agent should be able to execute it step by step.`,
    ];

    if (!useNativeTools) {
      sections.splice(2, 0, this.buildExploreToolDefinitions(), this.toolCallFormat());
    }

    return sections.filter(Boolean).join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Security review prompt — read-only analysis focused on vulnerabilities
  // ---------------------------------------------------------------------------

  buildSecurityReviewPrompt(workspaceFolders: readonly vscode.WorkspaceFolder[], primaryWorkspace?: vscode.WorkspaceFolder, useNativeTools?: boolean): string {
    const sections = [
      `You are a senior security engineer conducting a focused security review. Your goal is to find real, exploitable vulnerabilities — not theoretical issues.

STRICT CONSTRAINTS:
- You MUST NOT create, modify, or delete any files.
- You may only run read-only git commands (git diff, git log, git show) via run_terminal_command.
- Focus exclusively on finding security vulnerabilities.

WHAT TO LOOK FOR:
1. Input Validation — SQL injection, command injection, XXE, template injection, path traversal
2. Authentication & Authorization — auth bypass, privilege escalation, session flaws, JWT vulnerabilities
3. Crypto & Secrets — hardcoded keys/passwords, weak crypto, insecure key storage, bad randomness
4. Injection & Code Execution — RCE, deserialization flaws, eval injection, XSS
5. Data Exposure — sensitive data in logs, PII handling, API key leakage, debug info in production

METHODOLOGY:
1. Repository Context — Understand existing security frameworks, auth patterns, input validation approaches
2. Comparative Analysis — Look for deviations from established patterns (one endpoint missing auth, one query not parameterized)
3. Data Flow Tracing — Follow user input from entry point to database/output, looking for unvalidated paths

CONFIDENCE SCORING:
- Only report findings with >80% confidence of actual exploitability.
- For each finding, rate confidence 1-10. Drop anything below 8.

FALSE POSITIVE FILTERING — DO NOT FLAG:
- Denial of service / resource exhaustion (out of scope)
- Client-side permission checks (these are UX, not security)
- Test-only files (test fixtures, mock data, test utilities)
- Framework-provided protections (React auto-escaping, Angular sanitization)
- Secrets stored on disk in config files (standard practice for local dev)
- Rate limiting absence (operational concern, not vulnerability)
- Log spoofing (low impact)
- User content in AI/LLM prompts (prompt injection is a design choice, not a vulnerability)
- Memory safety issues in memory-safe languages (Rust, Go, etc.)

OUTPUT FORMAT:
For each real finding:
  ## [SEVERITY: Critical/High/Medium] Finding Title
  **File:** path/to/file.ext:L42
  **Confidence:** 9/10
  **Description:** What the vulnerability is and how it can be exploited
  **Impact:** What an attacker could achieve
  **Fix:** Specific code change to remediate`,
      this.workspaceInfo(workspaceFolders, primaryWorkspace),
      this.searchTips(),
      `COMPLETION:
When your review is complete, provide a summary:
- Total findings by severity
- Overall security posture assessment (1-2 sentences)
- Priority remediation order
Then respond with [TASK_COMPLETE].`,
    ];

    if (!useNativeTools) {
      sections.splice(2, 0, this.buildSecurityReviewToolDefinitions(), this.toolCallFormat());
    }

    return sections.filter(Boolean).join('\n\n');
  }

  /** Tool definitions for security review — read-only + limited git commands. */
  private buildSecurityReviewToolDefinitions(): string {
    const allowedNames = new Set([
      'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
      'get_document_symbols', 'find_definition', 'find_references',
      'find_implementations', 'find_symbol', 'get_hover_info',
      'get_call_hierarchy', 'get_type_hierarchy',
      'run_terminal_command',
    ]);
    const tools = this.toolRegistry.getAll().filter(t => allowedNames.has(t.name));
    const descriptions = tools.map((t: { name: string; description: string; schema?: any }) => {
      const params = t.schema?.properties
        ? Object.entries(t.schema.properties)
            .map(([key, val]: [string, any]) => `    ${key}: ${val.description || val.type}`)
            .join('\n')
        : '    (no parameters)';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n');
    return `TOOLS (read-only + git):\n${descriptions}\n\nNOTE: run_terminal_command is restricted to read-only git commands (git diff, git log, git show, git blame). Do not run any other commands.`;
  }

  // ---------------------------------------------------------------------------
  // Tool definition helpers for mode-restricted executors
  // ---------------------------------------------------------------------------

  /** Get Ollama native tool definitions filtered to read-only tools only. */
  getReadOnlyToolDefinitions(): any[] {
    const readOnlyNames = new Set([
      'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
      'get_document_symbols', 'find_definition', 'find_references',
      'find_implementations', 'find_symbol', 'get_hover_info',
      'get_call_hierarchy', 'get_type_hierarchy',
    ]);
    return this.toolRegistry.getOllamaToolDefinitions()
      .filter((td: any) => readOnlyNames.has(td.function?.name));
  }

  /** Get Ollama native tool definitions for security review (read-only + terminal). */
  getSecurityReviewToolDefinitions(): any[] {
    const allowedNames = new Set([
      'read_file', 'search_workspace', 'list_files', 'get_diagnostics',
      'get_document_symbols', 'find_definition', 'find_references',
      'find_implementations', 'find_symbol', 'get_hover_info',
      'get_call_hierarchy', 'get_type_hierarchy',
      'run_terminal_command',
    ]);
    return this.toolRegistry.getOllamaToolDefinitions()
      .filter((td: any) => allowedNames.has(td.function?.name));
  }
}
