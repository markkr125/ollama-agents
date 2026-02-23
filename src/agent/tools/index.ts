/**
 * Built-in agent tools — barrel export.
 *
 * Each tool is defined in its own file for single-responsibility.
 * Import `builtInTools` to register them all at once via
 * `ToolRegistry.registerBuiltInTools()`.
 */

import { Tool } from '../../types/agent';
import { listFilesTool } from './filesystem/listFiles';
import { readFileTool } from './filesystem/readFile';
import { writeFileTool } from './filesystem/writeFile';
import { findDefinitionTool } from './lsp/findDefinition';
import { findImplementationsTool } from './lsp/findImplementations';
import { findReferencesTool } from './lsp/findReferences';
import { findSymbolTool } from './lsp/findSymbol';
import { getCallHierarchyTool } from './lsp/getCallHierarchy';
import { getDiagnosticsTool } from './lsp/getDiagnostics';
import { getDocumentSymbolsTool } from './lsp/getDocumentSymbols';
import { getHoverInfoTool } from './lsp/getHoverInfo';
import { getTypeHierarchyTool } from './lsp/getTypeHierarchy';
import { runSubagentTool } from './runSubagent';
import { runTerminalCommandTool } from './runTerminalCommand';
import { searchWorkspaceTool } from './searchWorkspace';

/** All built-in tools in registration order. */
export const builtInTools: Tool[] = [
  readFileTool,
  writeFileTool,
  searchWorkspaceTool,
  listFilesTool,
  runTerminalCommandTool,
  getDiagnosticsTool,
  getDocumentSymbolsTool,
  findDefinitionTool,
  findReferencesTool,
  findImplementationsTool,
  findSymbolTool,
  getHoverInfoTool,
  getCallHierarchyTool,
  getTypeHierarchyTool,
  runSubagentTool,
];

export {
    findDefinitionTool,
    findImplementationsTool,
    findReferencesTool,
    findSymbolTool,
    getCallHierarchyTool,
    getDiagnosticsTool,
    getDocumentSymbolsTool,
    getHoverInfoTool,
    getTypeHierarchyTool,
    listFilesTool,
    readFileTool,
    runSubagentTool,
    runTerminalCommandTool,
    searchWorkspaceTool,
    writeFileTool
};

