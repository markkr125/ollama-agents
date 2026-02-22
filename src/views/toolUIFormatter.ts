export function getProgressGroupTitle(toolCalls: Array<{ name: string; args: any }>): string {
  const readCalls = toolCalls.filter(t => t.name === 'read_file');
  const writeCalls = toolCalls.filter(t => t.name === 'write_file' || t.name === 'create_file');
  const hasRead = readCalls.length > 0;
  const hasWrite = writeCalls.length > 0;
  const hasSearch = toolCalls.some(t => t.name === 'search_workspace' || t.name === 'find_symbol');
  const hasCommand = toolCalls.some(t => t.name === 'run_terminal_command' || t.name === 'run_command');
  const hasListFiles = toolCalls.some(t => t.name === 'list_files');
  const hasDiagnostics = toolCalls.some(t => t.name === 'get_diagnostics');
  const hasSubagent = toolCalls.some(t => t.name === 'run_subagent');
  const hasNavigation = toolCalls.some(t =>
    t.name === 'find_definition' || t.name === 'find_references' ||
    t.name === 'find_implementations' || t.name === 'get_hover_info' ||
    t.name === 'get_call_hierarchy' || t.name === 'get_type_hierarchy'
  );
  const hasSymbols = toolCalls.some(t => t.name === 'get_document_symbols');

  // Helper to get short filenames from tool args
  const getFileNames = (calls: Array<{ args: any }>, max: number = 3): string => {
    const names = calls.map(t => {
      const p = t.args?.path || t.args?.file || '';
      return p ? p.split('/').pop() : '';
    }).filter(Boolean);
    const unique = [...new Set(names)];
    if (unique.length === 0) return '';
    if (unique.length > max) return `${unique.slice(0, max).join(', ')} (+${unique.length - max})`;
    return unique.join(', ');
  };

  if (hasSubagent) return 'Delegating subtask';
  if (hasNavigation && hasSearch) return 'Tracing code paths';
  if (hasNavigation) return 'Analyzing code structure';
  if (hasSearch && hasRead) return 'Searching and reading code';
  if (hasSearch) return 'Searching codebase';
  if (hasSymbols && !hasWrite) return 'Inspecting file structure';
  if (hasDiagnostics && !hasWrite && !hasRead) return 'Checking diagnostics';
  if (hasWrite && hasRead) {
    const writeNames = getFileNames(writeCalls);
    return writeNames ? `Editing ${writeNames}` : 'Editing files';
  }
  if (hasWrite) {
    const writeNames = getFileNames(writeCalls);
    return writeNames ? `Writing ${writeNames}` : 'Writing files';
  }
  if (hasRead && !hasWrite && !hasSearch && !hasCommand && !hasListFiles) {
    // Read-only batch — show filenames in title
    const fileNames = getFileNames(readCalls, 5);
    if (!fileNames) return 'Reading files';
    return `Reading ${fileNames}`;
  }
  if (hasRead) return 'Reading files';
  if (hasListFiles) return 'Exploring workspace';
  if (hasCommand) return 'Running commands';
  return 'Executing task';
}

export function getToolActionInfo(
  toolName: string,
  args: any
): { actionText: string; actionDetail: string; actionIcon: string } {
  const path = args?.path || args?.file || '';
  const fileName = path ? path.split('/').pop() : '';

  switch (toolName) {
    case 'read_file':
      return {
        actionText: `Reading ${fileName || 'file'}`,
        actionDetail: args?.startLine ? `lines ${args.startLine}–${args.endLine || 'end'}` : '',
        actionIcon: '📄'
      };
    case 'write_file':
      return {
        actionText: `Write ${fileName || 'file'}`,
        actionDetail: '',
        actionIcon: '✏️'
      };
    case 'create_file':
      return {
        actionText: `Create ${fileName || 'file'}`,
        actionDetail: '',
        actionIcon: '📁'
      };
    case 'file_edit_approval':
      return {
        actionText: `Approve ${fileName || 'file'}`,
        actionDetail: 'Sensitive file edit',
        actionIcon: '🛡️'
      };
    case 'list_files':
      return {
        actionText: `List ${path || 'workspace'}`,
        actionDetail: '',
        actionIcon: '📋'
      };
    case 'search_workspace':
      return {
        actionText: `Search for "${args?.query || 'pattern'}"`,
        actionDetail: args?.filePattern ? `in ${args.filePattern}` : '',
        actionIcon: '🔍'
      };
    case 'run_command':
    case 'run_terminal_command':
      return {
        actionText: 'Run command',
        actionDetail: (args?.command || '').substring(0, 30),
        actionIcon: '⚡'
      };
    case 'run_subagent':
      return {
        actionText: args?.title || args?.task || 'Subtask',
        actionDetail: args?.mode === 'review' ? 'Security review' : 'Explore',
        actionIcon: '🤖'
      };
    case 'get_document_symbols':
      return {
        actionText: `Symbols in ${path ? fileName : 'file'}`,
        actionDetail: '',
        actionIcon: '🏗️'
      };
    case 'find_definition':
      return {
        actionText: `Definition of ${args?.symbolName || 'symbol'}`,
        actionDetail: path ? `in ${fileName}` : '',
        actionIcon: '🎯'
      };
    case 'find_references':
      return {
        actionText: `References to ${args?.symbolName || 'symbol'}`,
        actionDetail: path ? `from ${fileName}` : '',
        actionIcon: '🔗'
      };
    case 'find_symbol':
      return {
        actionText: `Find symbol "${args?.query || ''}"`,
        actionDetail: '',
        actionIcon: '🔍'
      };
    case 'get_hover_info':
      return {
        actionText: `Type info for ${args?.symbolName || 'symbol'}`,
        actionDetail: path ? `in ${fileName}` : '',
        actionIcon: '📝'
      };
    case 'get_call_hierarchy':
      return {
        actionText: `Call hierarchy of ${args?.symbolName || 'symbol'}`,
        actionDetail: args?.direction || 'both',
        actionIcon: '🌳'
      };
    case 'find_implementations':
      return {
        actionText: `Implementations of ${args?.symbolName || 'symbol'}`,
        actionDetail: path ? `in ${fileName}` : '',
        actionIcon: '🧩'
      };
    case 'get_type_hierarchy':
      return {
        actionText: `Type hierarchy of ${args?.symbolName || 'symbol'}`,
        actionDetail: args?.direction || 'both',
        actionIcon: '🏛️'
      };
    default:
      return {
        actionText: toolName,
        actionDetail: '',
        actionIcon: '🔧'
      };
  }
}

export function getToolSuccessInfo(
  toolName: string,
  args: any,
  output: string
): { actionText: string; actionDetail: string; filePath?: string; startLine?: number } {
  const path = args?.path || args?.file || '';
  const fileName = path ? path.split('/').pop() : 'file';

  switch (toolName) {
    case 'read_file': {
      const content = output || '';
      const lines = content ? content.split('\n').length : 0;
      const startLine = typeof args?.startLine === 'number' ? args.startLine : undefined;
      const endLine = typeof args?.endLine === 'number' ? args.endLine : undefined;
      const rangeDetail = startLine ? `lines ${startLine}–${endLine || startLine + lines - 1}` : `${lines} lines`;
      return {
        actionText: `Read ${fileName}`,
        actionDetail: rangeDetail,
        filePath: path,
        startLine
      };
    }
    case 'write_file':
      return {
        actionText: args?._isNew ? `Created ${fileName}` : `Edited ${fileName}`,
        actionDetail: '',
        filePath: path
      };
    case 'create_file':
      return {
        actionText: `Created ${fileName}`,
        actionDetail: '',
        filePath: path
      };
    case 'list_files': {
      const lines = output?.split('\n').filter(Boolean) || [];
      const folders = lines.filter(l => l.startsWith('📁')).length;
      const files = lines.filter(l => l.startsWith('📄')).length;
      const dirName = path ? path.split('/').pop() || path : 'workspace root';
      const basePath = path || '';
      const parts: string[] = [];
      if (files) parts.push(`${files} file${files !== 1 ? 's' : ''}`);
      if (folders) parts.push(`${folders} folder${folders !== 1 ? 's' : ''}`);
      const summary = parts.length ? parts.join(', ') : 'empty';
      // Summary line: "count summary\tbasePath" (tab-separated base path for click handling)
      // Each entry line: "📁 name" or "📄 name\tsize"
      const listing = lines.join('\n');
      return {
        actionText: `Listed ${dirName}`,
        actionDetail: listing ? `${summary}\t${basePath}\n${listing}` : summary
      };
    }
    case 'search_workspace': {
      const rawLines = output?.split('\n') || [];
      const query = args?.query || '';

      // Parse structured output: "── file ──" headers and "→ N:" match lines
      const fileMatches = new Map<string, number>();
      let currentFile = '';
      for (const line of rawLines) {
        const fileHeader = line.match(/^── (.+) ──$/);
        if (fileHeader) {
          currentFile = fileHeader[1];
          if (!fileMatches.has(currentFile)) fileMatches.set(currentFile, 0);
        } else if (line.startsWith('→') && currentFile) {
          fileMatches.set(currentFile, (fileMatches.get(currentFile) || 0) + 1);
        }
      }

      const totalMatches = [...fileMatches.values()].reduce((a, b) => a + b, 0);
      const fileCount = fileMatches.size;

      if (totalMatches === 0) {
        return {
          actionText: `No matches for "${query}"`,
          actionDetail: ''
        };
      }

      // Build parseListing-compatible detail:
      // Line 1 = summary (shown as muted text)
      // Remaining = "📄 path\tmatchCount" entries (rendered as listing)
      const listingLines = [...fileMatches.entries()]
        .map(([file, count]) => `📄 ${file}\t${count} match${count !== 1 ? 'es' : ''}`);

      return {
        actionText: `Found ${totalMatches} match${totalMatches !== 1 ? 'es' : ''} matching "${query}"`,
        actionDetail: `${fileCount} file${fileCount !== 1 ? 's' : ''}\n${listingLines.join('\n')}`
      };
    }
    case 'run_command':
    case 'run_terminal_command': {
      const exitCodeMatch = (output || '').match(/Exit code:\s*(\d+)/i);
      const exitCode = exitCodeMatch ? exitCodeMatch[1] : '';
      const cmd = (args?.command || '').substring(0, 40);
      return {
        actionText: 'Command completed',
        actionDetail: cmd ? `\`${cmd}\`${exitCode ? ` · exit ${exitCode}` : ''}` : (exitCode ? `exit ${exitCode}` : '')
      };
    }
    case 'run_subagent': {
      const summary = (output || '').split('\n')[0]?.substring(0, 80) || 'Completed';
      return {
        actionText: 'Sub-agent completed',
        actionDetail: summary
      };
    }
    case 'get_document_symbols': {
      const symbolLines = output?.split('\n').filter(Boolean) || [];
      const count = Math.max(0, symbolLines.length - 1); // minus header line
      return {
        actionText: `Found ${count} symbol${count !== 1 ? 's' : ''}`,
        actionDetail: path ? fileName : ''
        // No filePath — read-only tool has no checkpoint diff to navigate to
      };
    }
    case 'find_definition': {
      const hasResult = output && !output.includes('No definition found');
      return {
        actionText: hasResult ? 'Found definition' : 'No definition found',
        actionDetail: args?.symbolName || '',
      };
    }
    case 'find_references': {
      const refMatch = output?.match(/Found (\d+) reference/);
      const refCount = refMatch ? refMatch[1] : '0';
      return {
        actionText: `Found ${refCount} reference${refCount !== '1' ? 's' : ''}`,
        actionDetail: args?.symbolName || '',
      };
    }
    case 'find_symbol': {
      const symMatch = output?.match(/Found (\d+) symbol/);
      const symCount = symMatch ? symMatch[1] : '0';
      return {
        actionText: `Found ${symCount} symbol${symCount !== '1' ? 's' : ''}`,
        actionDetail: args?.query || '',
      };
    }
    case 'get_hover_info': {
      const hasHover = output && !output.includes('No hover information');
      return {
        actionText: hasHover ? 'Got type info' : 'No type info available',
        actionDetail: args?.symbolName || '',
      };
    }
    case 'get_call_hierarchy': {
      const hasHierarchy = output && !output.includes('No call hierarchy');
      return {
        actionText: hasHierarchy ? 'Got call hierarchy' : 'No call hierarchy available',
        actionDetail: args?.symbolName || '',
      };
    }
    case 'find_implementations': {
      const implMatch = output?.match(/(\d+) implementation/);
      const implCount = implMatch ? implMatch[1] : '0';
      return {
        actionText: `Found ${implCount} implementation${implCount !== '1' ? 's' : ''}`,
        actionDetail: args?.symbolName || '',
      };
    }
    case 'get_type_hierarchy': {
      const hasTypeHierarchy = output && !output.includes('No type hierarchy');
      return {
        actionText: hasTypeHierarchy ? 'Got type hierarchy' : 'No type hierarchy available',
        actionDetail: args?.symbolName || '',
      };
    }
    default:
      return {
        actionText: toolName,
        actionDetail: 'completed'
      };
  }
}
