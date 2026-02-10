export function getProgressGroupTitle(toolCalls: Array<{ name: string; args: any }>): string {
  const hasRead = toolCalls.some(t => t.name === 'read_file');
  const hasWrite = toolCalls.some(t => t.name === 'write_file' || t.name === 'create_file');
  const hasSearch = toolCalls.some(t => t.name === 'search_workspace');
  const hasCommand = toolCalls.some(t => t.name === 'run_terminal_command' || t.name === 'run_command');
  const hasListFiles = toolCalls.some(t => t.name === 'list_files');

  if (hasSearch) return 'Searching codebase';
  if (hasWrite && hasRead) return 'Modifying files';
  if (hasWrite) return 'Writing files';
  if (hasRead && toolCalls.length > 1) return 'Reading files';
  if (hasRead) return 'Analyzing code';
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
        actionText: `Read ${fileName || 'file'}`,
        actionDetail: args?.startLine ? `lines ${args.startLine} to ${args.endLine || 'end'}` : '',
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
): { actionText: string; actionDetail: string; filePath?: string } {
  const path = args?.path || args?.file || '';
  const fileName = path ? path.split('/').pop() : 'file';

  switch (toolName) {
    case 'read_file': {
      const content = output || '';
      const lines = content ? content.split('\n').length : 0;
      return {
        actionText: `Read ${fileName}`,
        actionDetail: `${lines} lines`
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
      const items = output?.split('\n').filter(Boolean).length || 0;
      return {
        actionText: `Listed ${path || 'workspace'}`,
        actionDetail: `${items} items`
      };
    }
    case 'search_workspace': {
      const matches = output?.split('\n').filter(Boolean).length || 0;
      return {
        actionText: `Searched "${args?.query || ''}"`,
        actionDetail: `${matches} results`
      };
    }
    case 'run_command':
    case 'run_terminal_command': {
      const exitCodeMatch = (output || '').match(/Exit code:\s*(\d+)/i);
      const exitCode = exitCodeMatch ? exitCodeMatch[1] : '';
      return {
        actionText: 'Command completed',
        actionDetail: exitCode ? `exit ${exitCode}` : ''
      };
    }
    default:
      return {
        actionText: toolName,
        actionDetail: 'completed'
      };
  }
}
