/**
 * Built-in agent tools — barrel export.
 *
 * Each tool is defined in its own file for single-responsibility.
 * Import `builtInTools` to register them all at once via
 * `ToolRegistry.registerBuiltInTools()`.
 */

import { Tool } from '../../types/agent';
import { getDiagnosticsTool } from './getDiagnostics';
import { listFilesTool } from './listFiles';
import { readFileTool } from './readFile';
import { runTerminalCommandTool } from './runTerminalCommand';
import { searchWorkspaceTool } from './searchWorkspace';
import { writeFileTool } from './writeFile';

/** All built-in tools in registration order. */
export const builtInTools: Tool[] = [
  readFileTool,
  writeFileTool,
  searchWorkspaceTool,
  listFilesTool,
  runTerminalCommandTool,
  getDiagnosticsTool,
];

export { getDiagnosticsTool, listFilesTool, readFileTool, runTerminalCommandTool, searchWorkspaceTool, writeFileTool };
