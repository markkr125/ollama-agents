import * as vscode from 'vscode';
import { Tool } from '../../../types/agent';
import { readContextAroundLocation, resolveSymbolPosition } from './symbolResolver';

/**
 * get_call_hierarchy — Trace call chains using the language server's call
 * hierarchy provider: "who calls this function?" (incoming) and "what does
 * this function call?" (outgoing).
 *
 * This enables the agent to follow call chains deeply — ask for outgoing
 * calls of handleMessage(), see it calls processRequest(), validateInput(),
 * sendResponse(), then drill into each.
 */

interface CallInfo {
  name: string;
  kind: string;
  file: string;
  line: number;
  context: string;
}

function symbolKindName(kind: vscode.SymbolKind): string {
  const names: Record<number, string> = {
    [vscode.SymbolKind.Method]: 'Method',
    [vscode.SymbolKind.Function]: 'Function',
    [vscode.SymbolKind.Constructor]: 'Constructor',
    [vscode.SymbolKind.Class]: 'Class',
    [vscode.SymbolKind.Interface]: 'Interface',
    [vscode.SymbolKind.Property]: 'Property',
    [vscode.SymbolKind.Variable]: 'Variable',
  };
  return names[kind] || 'Symbol';
}

export const getCallHierarchyTool: Tool = {
  name: 'get_call_hierarchy',
  description: 'Trace call chains for a function or method. "incoming" shows who calls this function. "outgoing" shows what this function calls. Uses the language server\'s call hierarchy provider. Provide a file path and either a symbol name or line/character position.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      symbolName: { type: 'string', description: 'Name of the function/method to trace calls for' },
      line: { type: 'number', description: 'Line number (1-based)' },
      character: { type: 'number', description: 'Column number (1-based)' },
      direction: { type: 'string', description: '"incoming" (who calls this?), "outgoing" (what does this call?), or "both". Default: "both"', enum: ['incoming', 'outgoing', 'both'] }
    },
    required: ['path']
  },
  execute: async (params, context) => {
    const { uri, position } = await resolveSymbolPosition(params, context.workspace, context.workspaceFolders);
    const direction = params.direction || 'both';

    // Prepare call hierarchy root
    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      'vscode.prepareCallHierarchy', uri, position
    );

    if (!items || items.length === 0) {
      const symbol = params.symbolName || `position ${params.line}:${params.character}`;
      return `No call hierarchy available for ${symbol}. The language server may not support call hierarchy for this symbol or file type.`;
    }

    const rootItem = items[0];
    const rootName = rootItem.name;
    const rootKind = symbolKindName(rootItem.kind);
    const rootFile = vscode.workspace.asRelativePath(rootItem.uri);
    const rootLine = rootItem.range.start.line + 1;

    const parts: string[] = [];
    parts.push(`Call hierarchy for ${rootKind} ${rootName} (${rootFile}:${rootLine}):\n`);

    // Incoming calls: who calls this function?
    if (direction === 'incoming' || direction === 'both') {
      const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls', rootItem
      );

      parts.push(`── Incoming calls (who calls ${rootName}?) ──`);

      if (!incoming || incoming.length === 0) {
        parts.push('  No incoming calls found.\n');
      } else {
        const calls: CallInfo[] = [];
        for (const call of incoming.slice(0, 15)) {
          const relPath = vscode.workspace.asRelativePath(call.from.uri);
          const line = call.from.range.start.line;
          const ctx = await readContextAroundLocation(call.from.uri, line, 1);
          calls.push({
            name: call.from.name,
            kind: symbolKindName(call.from.kind),
            file: relPath,
            line: line + 1,
            context: ctx
          });
        }

        for (const c of calls) {
          parts.push(`  ${c.kind} ${c.name} — ${c.file}:${c.line}`);
          parts.push(c.context);
          parts.push('');
        }

        if (incoming.length > 15) {
          parts.push(`  ... and ${incoming.length - 15} more callers\n`);
        }
      }
    }

    // Outgoing calls: what does this function call?
    if (direction === 'outgoing' || direction === 'both') {
      const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls', rootItem
      );

      parts.push(`── Outgoing calls (what does ${rootName} call?) ──`);

      if (!outgoing || outgoing.length === 0) {
        parts.push('  No outgoing calls found.\n');
      } else {
        const calls: CallInfo[] = [];
        for (const call of outgoing.slice(0, 20)) {
          const relPath = vscode.workspace.asRelativePath(call.to.uri);
          const line = call.to.range.start.line;
          const ctx = await readContextAroundLocation(call.to.uri, line, 1);
          calls.push({
            name: call.to.name,
            kind: symbolKindName(call.to.kind),
            file: relPath,
            line: line + 1,
            context: ctx
          });
        }

        for (const c of calls) {
          parts.push(`  ${c.kind} ${c.name} — ${c.file}:${c.line}`);
          parts.push(c.context);
          parts.push('');
        }

        if (outgoing.length > 20) {
          parts.push(`  ... and ${outgoing.length - 20} more calls\n`);
        }
      }
    }

    return parts.join('\n');
  }
};
