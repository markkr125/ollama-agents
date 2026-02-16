/**
 * Built-in agent tools — barrel export.
 *
 * Each tool is defined in its own file for single-responsibility.
 * Import `builtInTools` to register them all at once via
 * `ToolRegistry.registerBuiltInTools()`.
 */

import { Tool } from '../../types/agent';
import { findDefinitionTool } from './findDefinition';
import { findImplementationsTool } from './findImplementations';
import { findReferencesTool } from './findReferences';
import { findSymbolTool } from './findSymbol';
import { getCallHierarchyTool } from './getCallHierarchy';
import { getDiagnosticsTool } from './getDiagnostics';
import { getDocumentSymbolsTool } from './getDocumentSymbols';
import { getHoverInfoTool } from './getHoverInfo';
import { getTypeHierarchyTool } from './getTypeHierarchy';
import { listFilesTool } from './listFiles';
import { readFileTool } from './readFile';
import { runSubagentTool } from './runSubagent';
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

