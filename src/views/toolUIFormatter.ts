export function getProgressGroupTitle(toolCalls: Array<{ name: string; args: any }>): string {
  const readCalls = toolCalls.filter(t => t.name === 'read_file');
  const hasRead = readCalls.length > 0;
  const hasWrite = toolCalls.some(t => t.name === 'write_file' || t.name === 'create_file');
  const hasSearch = toolCalls.some(t => t.name === 'search_workspace');
  const hasCommand = toolCalls.some(t => t.name === 'run_terminal_command' || t.name === 'run_command');
  const hasListFiles = toolCalls.some(t => t.name === 'list_files');

  if (hasSearch) return 'Searching codebase';
  if (hasWrite && hasRead) return 'Modifying files';
  if (hasWrite) return 'Writing files';
  if (hasRead && !hasWrite && !hasSearch && !hasCommand && !hasListFiles) {
    // Read-only batch — show filenames in title
    const fileNames = readCalls.map(t => {
      const p = t.args?.path || t.args?.file || '';
      return p ? p.split('/').pop() : '';
    }).filter(Boolean);
    const unique = [...new Set(fileNames)];
    if (unique.length === 0) return 'Reading files';
    if (unique.length > 5) return 'Reading multiple files';
    return `Reading ${unique.join(', ')}`;
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
        actionText: `Edited ${fileName}`,
        actionDetail: '',
        filePath: path
      };
    case 'create_file':
      return {
        actionText: `Added ${fileName}`,
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
      const matchLines = output?.split('\n').filter(Boolean) || [];
      const matches = matchLines.length;
      const query = args?.query || '';
      const title = matches > 0 ? `Found ${matches} file${matches !== 1 ? 's' : ''} matching "${query}"` : `No files match "${query}"`;
      const listing = matches > 0 ? matchLines.join('\n') : '';
      return {
        actionText: title,
        actionDetail: listing
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
    default:
      return {
        actionText: toolName,
        actionDetail: 'completed'
      };
  }
}
